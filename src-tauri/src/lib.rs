// Shared entry for desktop and mobile. Tauri's mobile target generates a
// platform-specific main that calls into this `run` function — keep all
// builder setup here so the two targets stay identical.

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

// Core business logic — including the MCP client and the streaming / agentic
// tool-use loop — now lives in the platform-agnostic `taffy-core` crate. This
// shell just adapts the core `Stream<StreamEvent>` onto tauri's Channel and
// layers cancellation on top.
use taffy_core::llm::provider_kind;
use taffy_core::mcp::{McpServerConfig, McpState, McpTool};
use taffy_core::{ChatRequest, ChatResponse, EmbedRequest, StreamEvent};

const DB_FILE: &str = "taffy-studio.db";
const MAX_BACKUPS: usize = 7;

// DTOs (Attachment / ChatMessage / ChatRequest / ChatResponse / StreamEvent /
// ToolSpec) now live in `taffy-core` and are imported above.

// ---------- Cancellation registry ----------
//
// JS hands us a stream_id (uuid-ish). We store an AtomicBool per id; the
// stream loop checks it on every chunk. The matching `cancel_stream` command
// flips the flag. Map entries are dropped when the stream finishes.

#[derive(Default)]
pub struct Cancellation(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

async fn register_token(state: &State<'_, Cancellation>, id: &str) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    state.0.lock().await.insert(id.to_string(), token.clone());
    token
}

async fn unregister_token(state: &State<'_, Cancellation>, id: &str) {
    state.0.lock().await.remove(id);
}

#[tauri::command]
async fn cancel_stream(id: String, state: State<'_, Cancellation>) -> Result<bool, String> {
    let map = state.0.lock().await;
    if let Some(tok) = map.get(&id) {
        tok.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}

// ---------- Provider abstraction ----------

#[tauri::command]
fn ping(payload: String) -> String {
    format!("pong: {payload}")
}

// ---------- Secret storage ----------
//
// Desktop: backed by the OS credential manager via the `keyring` crate.
// Mobile (Android/iOS): no cross-platform Rust crate, so we report unsupported
// and the JS side falls back to its existing Store-based path. Wire native
// Keychain / Keystore later via tauri plugins.

const KEYRING_SERVICE: &str = "com.taffy.studio";

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (key, value);
        Err("secret_set unsupported on this platform; use Store fallback".into())
    }
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = key;
        Ok(None)
    }
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = key;
        Ok(())
    }
}

/// Returns true on platforms where secret_* commands actually persist.
#[tauri::command]
fn secret_supported() -> bool {
    cfg!(not(any(target_os = "android", target_os = "ios")))
}

// SSE parsing, per-provider message building, the plain `chat_stream`, and the
// agentic tool-use loop (`agentic_stream`) all live in `taffy_core::llm` now;
// the `chat_stream` command below just consumes whichever core stream applies.

// ---------- Commands ----------

// Thin Tauri wrappers over `taffy_core::llm`. The real logic is in the
// platform-agnostic core so the web shell can reuse it verbatim.
#[tauri::command]
async fn list_models(req: ChatRequest) -> Result<Vec<String>, String> {
    taffy_core::llm::list_models(&req).await
}

#[tauri::command]
async fn chat_complete(req: ChatRequest) -> Result<ChatResponse, String> {
    taffy_core::llm::chat_complete(&req).await
}

#[tauri::command]
async fn chat_stream(
    req: ChatRequest,
    on_event: Channel<StreamEvent>,
    state: State<'_, Cancellation>,
    mcp_state: State<'_, Arc<McpState>>,
) -> Result<(), String> {
    // Register a cancellation token if the caller gave us a stream_id. The flag
    // is polled between events below; flipping it (via `cancel_stream`) makes us
    // stop consuming the core stream, which drops the in-flight HTTP request.
    let token = if let Some(id) = req.stream_id.as_deref() {
        Some((id.to_string(), register_token(&state, id).await))
    } else {
        None
    };
    let flag = token.as_ref().map(|(_, t)| t.clone());

    // Agentic path: tools attached + a provider that supports tool use → drive
    // the multi-round loop. Gemini tool-use isn't wired yet, so it falls through
    // to a plain stream (tools ignored). Both branches are core `Stream`s; box
    // them to a single type so the consume loop is written once.
    let kind = provider_kind(&req.provider);
    let use_tools = matches!(kind, "openai" | "anthropic")
        && req.tools.as_ref().is_some_and(|t| !t.is_empty());

    let mut stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = StreamEvent> + Send>,
    > = if use_tools {
        let tools = req.tools.clone().unwrap_or_default();
        let mcp = mcp_state.inner().clone();
        Box::pin(taffy_core::llm::agentic_stream(req, tools, mcp))
    } else {
        Box::pin(taffy_core::llm::chat_stream(req))
    };

    // Accumulate Token text so a mid-stream cancel can report what we had, the
    // same as the old loop's `Cancelled { content: full }`.
    let mut acc = String::new();
    while let Some(ev) = stream.next().await {
        if let Some(f) = &flag {
            if f.load(Ordering::SeqCst) {
                let _ = on_event.send(StreamEvent::Cancelled {
                    content: std::mem::take(&mut acc),
                });
                break;
            }
        }
        if let StreamEvent::Token { content } = &ev {
            acc.push_str(content);
        }
        let _ = on_event.send(ev);
    }

    if let Some((id, _)) = &token {
        unregister_token(&state, id).await;
    }
    Ok(())
}

// ---------- MCP commands ----------

#[tauri::command]
async fn mcp_connect(
    config: McpServerConfig,
    state: State<'_, Arc<McpState>>,
) -> Result<Vec<McpTool>, String> {
    taffy_core::mcp::connect(&state, config).await
}

#[tauri::command]
async fn mcp_disconnect(id: String, state: State<'_, Arc<McpState>>) -> Result<(), String> {
    taffy_core::mcp::disconnect(&state, &id).await;
    Ok(())
}

#[tauri::command]
async fn mcp_list_tools(state: State<'_, Arc<McpState>>) -> Result<Vec<McpTool>, String> {
    Ok(taffy_core::mcp::all_tools(&state).await)
}

#[tauri::command]
async fn mcp_call_tool(
    server_id: String,
    name: String,
    args: serde_json::Value,
    state: State<'_, Arc<McpState>>,
) -> Result<String, String> {
    taffy_core::mcp::call_tool(&state, &server_id, &name, args).await
}

// ---------- Embeddings (RAG) ----------
//
// One HTTP call to an OpenAI-compatible /embeddings endpoint. Keeping it in
// Rust matches the rest of the app: the API key never reaches the webview.
// The vector store + cosine search live on the JS side (see src/lib/rag.ts);
// for the local-app scale (thousands of chunks) a brute-force cosine in JS is
// plenty, and it avoids a native sqlite-vec extension dependency.

// Thin wrapper — embedding logic lives in `taffy_core::llm`.
#[tauri::command]
async fn embed_texts(req: EmbedRequest) -> Result<Vec<Vec<f32>>, String> {
    taffy_core::llm::embed_texts(&req).await
}

// ---------- DB safety net (backups + storage info) ----------
//
// On every startup we copy the live DB into a sibling `backups/` folder.
// We keep MAX_BACKUPS files and prune older ones. The copy happens BEFORE the
// SQL plugin gets a chance to run migrations, so even if a future migration
// corrupts the schema, the user can restore by replacing taffy-studio.db with
// the most recent backup file.

fn db_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app_config_dir: {e}"))
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(db_dir(app)?.join(DB_FILE))
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(db_dir(app)?.join("backups"))
}

fn ts_now() -> String {
    // YYYYMMDD-HHMMSS in local-ish format. We avoid depending on chrono;
    // SystemTime since UNIX_EPOCH plus a manual breakdown is good enough for
    // file names.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Rough local: ignore TZ to keep this dependency-free; file names are
    // sortable lexicographically which is what we actually need.
    let (y, mo, d, h, mi, s) = ymd_hms(secs);
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", y, mo, d, h, mi, s)
}

/// Convert seconds-since-epoch to (Y, M, D, h, m, s) in UTC. Good enough for
/// backup file names; we don't need locale-correct times here.
fn ymd_hms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let h = (rem / 3600) as u32;
    let mi = ((rem % 3600) / 60) as u32;
    let s = (rem % 60) as u32;
    // Civil from days (https://howardhinnant.github.io/date_algorithms.html)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y_civ = yoe as i32 + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y_civ + 1 } else { y_civ };
    (y, m, d, h, mi, s)
}

fn copy_backup(db_path: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let name = format!("{}.bak-{}", DB_FILE, ts_now());
    let dest = dest_dir.join(name);
    std::fs::copy(db_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

fn list_backups(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{}.bak-", DB_FILE)))
        })
        .collect();
    // newest first (timestamp suffix sorts lexically)
    v.sort();
    v.reverse();
    v
}

fn prune_backups(dir: &Path, keep: usize) {
    for old in list_backups(dir).into_iter().skip(keep) {
        let _ = std::fs::remove_file(&old);
    }
}

/// Run a one-shot backup at startup. Idempotent within ~5 seconds (skips if
/// the newest backup is fresher than that, so we don't spam files when the
/// user restarts the app repeatedly during dev).
fn startup_backup(app: &AppHandle) {
    let Ok(db) = db_path(app) else { return };
    if !db.exists() {
        // Brand-new install; nothing to back up.
        return;
    }
    let Ok(dir) = backups_dir(app) else { return };

    // Skip if we already wrote a backup very recently.
    if let Some(latest) = list_backups(&dir).first() {
        if let Ok(meta) = std::fs::metadata(latest) {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = SystemTime::now().duration_since(modified) {
                    if age.as_secs() < 5 {
                        return;
                    }
                }
            }
        }
    }

    match copy_backup(&db, &dir) {
        Ok(path) => {
            log::info!("DB backup created at {}", path.display());
            prune_backups(&dir, MAX_BACKUPS);
        }
        Err(e) => log::warn!("DB backup failed: {e}"),
    }
}

// ---------- Storage commands (exposed to UI) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub size: u64,
    /// Unix seconds.
    pub modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub db_path: String,
    pub db_size: u64,
    pub backups_dir: String,
    pub backups: Vec<BackupInfo>,
}

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn mtime_secs(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn storage_info(app: AppHandle) -> Result<StorageInfo, String> {
    let db = db_path(&app)?;
    let dir = backups_dir(&app)?;
    let backups = list_backups(&dir)
        .into_iter()
        .map(|p| BackupInfo {
            size: file_size(&p),
            modified: mtime_secs(&p),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    Ok(StorageInfo {
        db_path: db.to_string_lossy().into_owned(),
        db_size: if db.exists() { file_size(&db) } else { 0 },
        backups_dir: dir.to_string_lossy().into_owned(),
        backups,
    })
}

#[tauri::command]
fn backup_now(app: AppHandle) -> Result<BackupInfo, String> {
    let db = db_path(&app)?;
    if !db.exists() {
        return Err("Database file does not exist yet".into());
    }
    let dir = backups_dir(&app)?;
    let path = copy_backup(&db, &dir)?;
    prune_backups(&dir, MAX_BACKUPS);
    Ok(BackupInfo {
        size: file_size(&path),
        modified: mtime_secs(&path),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Caller is responsible for showing a confirmation dialog before invoking
/// this. We do NOT delete the backups directory — they survive a reset on
/// purpose, so the user can recover.
#[tauri::command]
fn reset_database(app: AppHandle, db: State<'_, taffy_core::Db>) -> Result<(), String> {
    let dbfile = db_path(&app)?;
    let dir = backups_dir(&app)?;
    // Belt-and-suspenders: take one more snapshot before wiping.
    if dbfile.exists() {
        let _ = copy_backup(&dbfile, &dir);
        prune_backups(&dir, MAX_BACKUPS + 1);
    }
    // Wipe in-connection (don't unlink an open file — Windows won't allow it).
    db.reset()
}

// ---------- File I/O helpers for dialog-picked paths ----------
//
// These commands take an absolute path that the user has explicitly chosen
// via the dialog plugin (`save` / `open`). They intentionally do not enforce
// a scope — that's already gated by the OS-native dialog showing the user
// what they picked. Used by the JSON export / import flow in the Storage
// panel; not a generic file I/O surface for arbitrary callers.

#[tauri::command]
fn fs_write_text_abs(path: String, contents: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(p, contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read_text_abs(path: String) -> Result<String, String> {
    std::fs::read_to_string(Path::new(&path)).map_err(|e| e.to_string())
}

/// Reveal the app config directory in the system file manager.
#[tauri::command]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    let dir = db_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = path;
        return Err("Open folder is not supported on mobile".into());
    }
    Ok(())
}

// ---------- Data layer (taffy-core::db) ----------
//
// Thin Tauri commands over the shared SQLite layer. The DB handle is opened +
// migrated once in setup() and kept as managed state.

#[tauri::command]
fn conv_list(db: State<'_, taffy_core::Db>) -> Result<Vec<taffy_core::Conversation>, String> {
    db.list_conversations()
}

#[tauri::command]
fn conv_create(
    db: State<'_, taffy_core::Db>,
    title: String,
    init: Option<taffy_core::db::ConversationInit>,
) -> Result<taffy_core::Conversation, String> {
    db.create_conversation(&title, &init.unwrap_or_default())
}

#[tauri::command]
fn conv_update_model(
    db: State<'_, taffy_core::Db>,
    id: String,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    db.update_conversation_model(&id, provider_id.as_deref(), model.as_deref())
}

#[tauri::command]
fn conv_update_temperature(
    db: State<'_, taffy_core::Db>,
    id: String,
    temperature: Option<f64>,
) -> Result<(), String> {
    db.update_conversation_temperature(&id, temperature)
}

#[tauri::command]
fn conv_update_max_tokens(
    db: State<'_, taffy_core::Db>,
    id: String,
    max_tokens: Option<i64>,
) -> Result<(), String> {
    db.update_conversation_max_tokens(&id, max_tokens)
}

#[tauri::command]
fn conv_update_system_prompt(
    db: State<'_, taffy_core::Db>,
    id: String,
    system_prompt: Option<String>,
) -> Result<(), String> {
    db.update_conversation_system_prompt(&id, system_prompt.as_deref())
}

#[tauri::command]
fn conv_update_title(
    db: State<'_, taffy_core::Db>,
    id: String,
    title: String,
) -> Result<(), String> {
    db.update_conversation_title(&id, &title)
}

#[tauri::command]
fn conv_update_pinned(
    db: State<'_, taffy_core::Db>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    db.update_conversation_pinned(&id, pinned)
}

#[tauri::command]
fn conv_delete(db: State<'_, taffy_core::Db>, id: String) -> Result<(), String> {
    db.delete_conversation(&id)
}

#[tauri::command]
fn msg_append(
    db: State<'_, taffy_core::Db>,
    conversation_id: String,
    role: String,
    content: String,
    attachments: Option<serde_json::Value>,
) -> Result<taffy_core::Message, String> {
    db.append_message(&conversation_id, &role, &content, attachments)
}

#[tauri::command]
fn msg_list(
    db: State<'_, taffy_core::Db>,
    conversation_id: String,
) -> Result<Vec<taffy_core::Message>, String> {
    db.list_messages(&conversation_id)
}

#[tauri::command]
fn msg_delete(db: State<'_, taffy_core::Db>, id: String) -> Result<(), String> {
    db.delete_message(&id)
}

#[tauri::command]
fn kv_get(
    db: State<'_, taffy_core::Db>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    db.kv_get(&key)
}

#[tauri::command]
fn kv_set(
    db: State<'_, taffy_core::Db>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    db.kv_set(&key, &value)
}

#[tauri::command]
fn kv_delete(db: State<'_, taffy_core::Db>, key: String) -> Result<(), String> {
    db.kv_delete(&key)
}

#[tauri::command]
fn db_select(
    db: State<'_, taffy_core::Db>,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<Vec<serde_json::Value>, String> {
    db.select_json(&sql, &params.unwrap_or_default())
}

#[tauri::command]
fn db_execute(
    db: State<'_, taffy_core::Db>,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<taffy_core::db::ExecResult, String> {
    db.execute_sql(&sql, &params.unwrap_or_default())
}

#[tauri::command]
fn db_init() -> Result<(), String> {
    // The DB is opened + migrated in setup(); nothing to do here.
    Ok(())
}

// ---------- RAG (knowledge bases) ----------
//
// Storage + cosine search live in taffy-core::db; embedding stays frontend-side
// (provider/key resolution lives in JS settings) and reaches the chunks here.

#[tauri::command]
fn rag_list_kbs(db: State<'_, taffy_core::Db>) -> Result<Vec<taffy_core::KnowledgeBase>, String> {
    db.list_knowledge_bases()
}

#[tauri::command]
fn rag_create_kb(
    db: State<'_, taffy_core::Db>,
    name: String,
    provider_id: Option<String>,
    embed_model: Option<String>,
) -> Result<taffy_core::KnowledgeBase, String> {
    db.create_knowledge_base(&name, provider_id.as_deref(), embed_model.as_deref())
}

#[tauri::command]
fn rag_update_kb(
    db: State<'_, taffy_core::Db>,
    id: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    db.update_knowledge_base(&id, &patch)
}

#[tauri::command]
fn rag_delete_kb(db: State<'_, taffy_core::Db>, id: String) -> Result<(), String> {
    db.delete_knowledge_base(&id)
}

#[tauri::command]
fn rag_list_docs(
    db: State<'_, taffy_core::Db>,
    kb_id: String,
) -> Result<Vec<taffy_core::DocSummary>, String> {
    db.list_documents(&kb_id)
}

#[tauri::command]
fn rag_count_chunks(db: State<'_, taffy_core::Db>, kb_id: String) -> Result<i64, String> {
    db.count_chunks(&kb_id)
}

#[tauri::command]
fn rag_delete_doc(db: State<'_, taffy_core::Db>, doc_id: String) -> Result<(), String> {
    db.delete_document(&doc_id)
}

#[tauri::command]
fn rag_add_chunks(
    db: State<'_, taffy_core::Db>,
    kb_id: String,
    doc_id: String,
    source: String,
    items: Vec<taffy_core::ChunkInput>,
) -> Result<usize, String> {
    db.add_chunks(&kb_id, &doc_id, &source, &items)
}

#[tauri::command]
fn rag_search(
    db: State<'_, taffy_core::Db>,
    kb_id: String,
    embedding: Vec<f64>,
    top_k: usize,
) -> Result<Vec<taffy_core::RetrievedChunk>, String> {
    db.search_knowledge(&kb_id, &embedding, top_k)
}

// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                // App default = Info: keep our own info/warn/error, drop the
                // h2/hyper/reqwest TRACE spam. Override per-target if a deep
                // dive is needed (e.g. `.level_for("reqwest", LevelFilter::Trace)`).
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(Cancellation::default())
        .manage(Arc::new(McpState::default()))
        .setup(|app| {
            // Backup BEFORE migrations run. If a future migration corrupts the
            // schema, the user can revert by copying the latest backup over
            // taffy-studio.db.
            startup_backup(app.handle());
            // Open + migrate the SQLite data layer (taffy-core), then keep the
            // handle as managed state for the conv_/msg_/kv_/db_ commands.
            let path = db_path(app.handle())?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let db = taffy_core::Db::open(&path.to_string_lossy())?;
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            chat_complete,
            chat_stream,
            cancel_stream,
            list_models,
            secret_set,
            secret_get,
            secret_delete,
            secret_supported,
            storage_info,
            backup_now,
            reset_database,
            open_config_dir,
            fs_write_text_abs,
            fs_read_text_abs,
            mcp_connect,
            mcp_disconnect,
            mcp_list_tools,
            mcp_call_tool,
            embed_texts,
            // data layer (taffy-core::db)
            conv_list,
            conv_create,
            conv_update_model,
            conv_update_temperature,
            conv_update_max_tokens,
            conv_update_system_prompt,
            conv_update_title,
            conv_update_pinned,
            conv_delete,
            msg_append,
            msg_list,
            msg_delete,
            kv_get,
            kv_set,
            kv_delete,
            db_select,
            db_execute,
            db_init,
            // RAG (taffy-core::db knowledge bases)
            rag_list_kbs,
            rag_create_kb,
            rag_update_kb,
            rag_delete_kb,
            rag_list_docs,
            rag_count_chunks,
            rag_delete_doc,
            rag_add_chunks,
            rag_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


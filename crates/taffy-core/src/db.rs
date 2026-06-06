//! SQLite data layer — shared by both shells (Tauri commands + axum routes).
//!
//! This is the single source of truth for the schema (migration chain) and the
//! semantic query operations. The frontend talks to it through the `api` layer
//! (Tauri invoke / HTTP) instead of shipping raw SQL, which is what lets the
//! same UI run on desktop and in a browser.
//!
//! Scope so far: migrations + KV + conversations + messages + RAG (knowledge
//! bases: storage + cosine search). Full-text search and export/import still
//! ride the generic-SQL escape hatch pending their own semantic endpoints.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Tauri bundle identifier — the app config subdir both shells use.
const APP_DIR: &str = "com.taffy.studio";
const DB_FILE: &str = "taffy-studio.db";

/// Default database location, shared by the desktop and web shells so they use
/// ONE config + history. Resolves to the same place Tauri's `app_config_dir`
/// does (`dirs::config_dir()/com.taffy.studio/taffy-studio.db`):
///   - Windows: %APPDATA%\com.taffy.studio\taffy-studio.db
///   - macOS:   ~/Library/Application Support/com.taffy.studio/taffy-studio.db
///   - Linux:   ~/.config/com.taffy.studio/taffy-studio.db
pub fn default_db_path() -> String {
    let base = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join(APP_DIR)
        .join(DB_FILE)
        .to_string_lossy()
        .into_owned()
}

// ---------- Schema migrations ----------
//
// Ported verbatim from the previous tauri-plugin-sql chain so existing
// databases keep the same shape. Tracked via `PRAGMA user_version` (version =
// index + 1). v9 adds the `kv` table that used to live in plugin-store.
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);
    "#,
    // v2 — attachments column
    "ALTER TABLE messages ADD COLUMN attachments TEXT NULL;",
    // v3 — per-conversation provider + model
    "ALTER TABLE conversations ADD COLUMN provider_id TEXT NULL;
     ALTER TABLE conversations ADD COLUMN model TEXT NULL;",
    // v4 — per-conversation temperature
    "ALTER TABLE conversations ADD COLUMN temperature REAL NULL;",
    // v5 — pin flag
    "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    // v6 — max_tokens + system_prompt
    "ALTER TABLE conversations ADD COLUMN max_tokens INTEGER NULL;
     ALTER TABLE conversations ADD COLUMN system_prompt TEXT NULL;",
    // v7 — FTS5 over messages.content (external-content + sync triggers)
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
         content,
         content='messages',
         content_rowid='rowid',
         tokenize='unicode61 remove_diacritics 2'
     );
     CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
         INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
     END;
     CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
         INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
     END;
     CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
         INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
         INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
     END;
     INSERT INTO messages_fts(messages_fts) VALUES('rebuild');",
    // v8 — knowledge bases + chunks (local RAG)
    "CREATE TABLE IF NOT EXISTS knowledge_bases (
         id          TEXT PRIMARY KEY,
         name        TEXT NOT NULL,
         provider_id TEXT NULL,
         embed_model TEXT NULL,
         dim         INTEGER NULL,
         created_at  INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS knowledge_chunks (
         id          TEXT PRIMARY KEY,
         kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
         doc_id      TEXT NOT NULL,
         source      TEXT NOT NULL,
         text        TEXT NOT NULL,
         embedding   TEXT NOT NULL,
         created_at  INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_chunks_kb ON knowledge_chunks(kb_id);
     CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);",
    // v9 — key/value settings (previously plugin-store settings.json)
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // v10 — per-message model label (multi-model fan-out tags each assistant
    // reply with the model that produced it, for column rendering + per-model
    // history).
    "ALTER TABLE messages ADD COLUMN model TEXT NULL;",
];

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> bool {
    let mut stmt = match conn.prepare(&format!("PRAGMA table_info({table})")) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(_) => return false,
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(name) = row.get::<_, String>(1) {
            if name == col {
                return true;
            }
        }
    }
    false
}

/// `(schema_version, schema-probe)` pair: if the probe sees its columns/tables,
/// the DB is at least at that version. Used by `detect_baseline`.
type BaselineCheck = (i64, fn(&Connection) -> bool);

/// Infer how far a pre-existing database was migrated by probing its schema.
/// Needed because the old desktop chain (tauri-plugin-sql) tracked progress in
/// its own table, not `PRAGMA user_version` — so an existing v8 DB shows
/// user_version 0 and would otherwise re-run non-idempotent ALTERs.
fn detect_baseline(conn: &Connection) -> i64 {
    if !table_exists(conn, "conversations") {
        return 0;
    }
    let mut v = 1;
    let checks: &[BaselineCheck] = &[
        (2, |c| column_exists(c, "messages", "attachments")),
        (3, |c| column_exists(c, "conversations", "provider_id")),
        (4, |c| column_exists(c, "conversations", "temperature")),
        (5, |c| column_exists(c, "conversations", "pinned")),
        (6, |c| column_exists(c, "conversations", "system_prompt")),
        (7, |c| table_exists(c, "messages_fts")),
        (8, |c| table_exists(c, "knowledge_bases")),
        (9, |c| table_exists(c, "kv")),
        (10, |c| column_exists(c, "messages", "model")),
    ];
    for (ver, present) in checks {
        if present(conn) {
            v = *ver;
        } else {
            break;
        }
    }
    v
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    let mut current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(e2s)?;
    // Adopt a DB previously migrated by plugin-sql (user_version still 0).
    if current == 0 {
        let baseline = detect_baseline(conn);
        if baseline > 0 {
            conn.execute_batch(&format!("PRAGMA user_version = {baseline};"))
                .map_err(e2s)?;
            current = baseline;
        }
    }
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = (i + 1) as i64;
        if v > current {
            conn.execute_batch(sql)
                .map_err(|e| format!("migration v{v} failed: {e}"))?;
            conn.execute_batch(&format!("PRAGMA user_version = {v};"))
                .map_err(e2s)?;
        }
    }
    Ok(())
}

// ---------- DTOs (mirror the frontend wire shapes) ----------

/// Conversation row. Field names are snake_case to match the frontend's
/// `Conversation` interface on the wire.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub pinned: Option<i64>,
    pub max_tokens: Option<i64>,
    pub system_prompt: Option<String>,
}

/// Optional initial state for a new conversation. camelCase to match the
/// frontend's `ConversationInit`.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInit {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<i64>,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

/// Message row. `attachments` is the parsed JSON array (or null), so the
/// frontend doesn't have to parse a TEXT column.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    /// Model that produced this (assistant) message, e.g. "gpt-4o". Null for
    /// user/system/tool turns and legacy rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

// ---------- RAG DTOs (local knowledge bases) ----------
//
// snake_case field names match the frontend's `KnowledgeBase` / `DocSummary` /
// `RetrievedChunk` interfaces on the wire (same convention as `Conversation`).

/// A knowledge base row. `dim` is the embedding dimensionality, captured on the
/// first chunk inserted.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub provider_id: Option<String>,
    pub embed_model: Option<String>,
    pub dim: Option<i64>,
    pub created_at: i64,
}

/// One document's footprint in a KB (grouped chunks), for the document list.
#[derive(Serialize, Debug)]
pub struct DocSummary {
    pub doc_id: String,
    pub source: String,
    pub chunks: i64,
}

/// A retrieval hit: chunk text + its source + cosine score against the query.
#[derive(Serialize, Debug)]
pub struct RetrievedChunk {
    pub text: String,
    pub source: String,
    pub score: f64,
}

/// One chunk to index: its text plus the embedding the frontend computed (the
/// embedding call stays frontend-side so provider/key resolution lives in one
/// place; storage + search are server-side so both shells share them).
#[derive(Deserialize, Debug)]
pub struct ChunkInput {
    pub text: String,
    #[serde(default)]
    pub embedding: Vec<f64>,
}

// ---------- Search + export/import DTOs ----------

/// One FTS5 hit. `excerpt_raw` carries the snippet with `char(1)`/`char(2)`
/// marker bytes around matched terms; the frontend HTML-escapes it then swaps
/// the markers for `<b>`/`</b>` (kept frontend-side so the markup stays there).
#[derive(Serialize, Debug)]
pub struct SearchHit {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub role: String,
    pub excerpt_raw: String,
    pub created_at: i64,
}

/// A message inside an export document. `id` is serialized on export and
/// ignored on import (new ids are minted), hence `#[serde(default)]`.
#[derive(Serialize, Deserialize, Debug)]
pub struct ExportedMessage {
    #[serde(default)]
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    #[serde(default)]
    pub attachments: Option<serde_json::Value>,
}

/// A conversation inside an export document, with its messages inlined. Optional
/// fields default on import so older export files round-trip. The frontend
/// validates + normalizes arbitrary import JSON before it reaches here.
#[derive(Serialize, Deserialize, Debug)]
pub struct ExportedConversation {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub pinned: Option<i64>,
    #[serde(default)]
    pub max_tokens: Option<i64>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub messages: Vec<ExportedMessage>,
}

/// Counts of what an import actually inserted.
#[derive(Serialize, Debug)]
pub struct ImportSummary {
    pub conversations: i64,
    pub messages: i64,
}

// ---------- Db handle ----------

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (or create) the database at `path` and run pending migrations.
    /// Creates the parent directory if needed; enables WAL so the desktop and
    /// web shells can safely share one file.
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(e2s)?;
            }
        }
        let conn = Connection::open(path).map_err(e2s)?;
        // WAL + a busy timeout make concurrent access from two processes
        // (e.g. desktop app + web server on the same file) robust.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
        )
        .map_err(e2s)?;
        run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory database (tests).
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(e2s)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(e2s)?;
        run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db mutex poisoned")
    }

    // ----- conversations -----

    pub fn list_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, created_at, updated_at, provider_id, model, \
                 temperature, pinned, max_tokens, system_prompt \
                 FROM conversations ORDER BY pinned DESC, updated_at DESC",
            )
            .map_err(e2s)?;
        let rows = stmt
            .query_map([], row_to_conversation)
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        Ok(rows)
    }

    pub fn create_conversation(
        &self,
        title: &str,
        init: &ConversationInit,
    ) -> Result<Conversation, String> {
        let now = now_ms();
        let system_prompt = init
            .system_prompt
            .as_ref()
            .filter(|s| !s.is_empty())
            .cloned();
        let row = Conversation {
            id: new_id(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            provider_id: init.provider_id.clone(),
            model: init.model.clone(),
            temperature: init.temperature,
            pinned: Some(0),
            max_tokens: init.max_tokens,
            system_prompt,
        };
        self.lock()
            .execute(
                "INSERT INTO conversations \
                 (id, title, created_at, updated_at, provider_id, model, temperature, max_tokens, system_prompt) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    row.id,
                    row.title,
                    row.created_at,
                    row.updated_at,
                    row.provider_id,
                    row.model,
                    row.temperature,
                    row.max_tokens,
                    row.system_prompt,
                ],
            )
            .map_err(e2s)?;
        Ok(row)
    }

    pub fn update_conversation_model(
        &self,
        id: &str,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE conversations SET provider_id = ?1, model = ?2, updated_at = ?3 WHERE id = ?4",
                params![provider_id, model, now_ms(), id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn update_conversation_temperature(
        &self,
        id: &str,
        temperature: Option<f64>,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE conversations SET temperature = ?1, updated_at = ?2 WHERE id = ?3",
                params![temperature, now_ms(), id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn update_conversation_max_tokens(
        &self,
        id: &str,
        max_tokens: Option<i64>,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE conversations SET max_tokens = ?1, updated_at = ?2 WHERE id = ?3",
                params![max_tokens, now_ms(), id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn update_conversation_system_prompt(
        &self,
        id: &str,
        system_prompt: Option<&str>,
    ) -> Result<(), String> {
        let normalized = system_prompt.filter(|s| !s.is_empty());
        self.lock()
            .execute(
                "UPDATE conversations SET system_prompt = ?1, updated_at = ?2 WHERE id = ?3",
                params![normalized, now_ms(), id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, now_ms(), id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn update_conversation_pinned(&self, id: &str, pinned: bool) -> Result<(), String> {
        // Intentionally leaves updated_at untouched (layout-only flip).
        self.lock()
            .execute(
                "UPDATE conversations SET pinned = ?1 WHERE id = ?2",
                params![if pinned { 1 } else { 0 }, id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )
        .map_err(e2s)?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(e2s)?;
        Ok(())
    }

    // ----- messages -----

    pub fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        attachments: Option<serde_json::Value>,
        model: Option<&str>,
    ) -> Result<Message, String> {
        let now = now_ms();
        let attachments =
            attachments.filter(|v| !matches!(v, serde_json::Value::Array(a) if a.is_empty()));
        let attachments_json = match &attachments {
            Some(v) => Some(serde_json::to_string(v).map_err(e2s)?),
            None => None,
        };
        let row = Message {
            id: new_id(),
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            created_at: now,
            attachments,
            model: model.map(|s| s.to_string()),
        };
        let conn = self.lock();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at, attachments, model) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.conversation_id,
                row.role,
                row.content,
                row.created_at,
                attachments_json,
                row.model,
            ],
        )
        .map_err(e2s)?;
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )
        .map_err(e2s)?;
        Ok(row)
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, created_at, attachments, model \
                 FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(e2s)?;
        let rows = stmt
            .query_map(params![conversation_id], row_to_message)
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        Ok(rows)
    }

    pub fn delete_message(&self, id: &str) -> Result<(), String> {
        self.lock()
            .execute("DELETE FROM messages WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(e2s)
    }

    // ----- key/value settings -----

    pub fn kv_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let conn = self.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(e2s)?;
        match raw {
            Some(s) => Ok(Some(serde_json::from_str(&s).map_err(e2s)?)),
            None => Ok(None),
        }
    }

    pub fn kv_set(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        let s = serde_json::to_string(value).map_err(e2s)?;
        self.lock()
            .execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, s],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    pub fn kv_delete(&self, key: &str) -> Result<(), String> {
        self.lock()
            .execute("DELETE FROM kv WHERE key = ?1", params![key])
            .map(|_| ())
            .map_err(e2s)
    }

    // ----- RAG: knowledge bases + chunks -----

    pub fn list_knowledge_bases(&self) -> Result<Vec<KnowledgeBase>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, provider_id, embed_model, dim, created_at \
                 FROM knowledge_bases ORDER BY created_at DESC",
            )
            .map_err(e2s)?;
        let rows = stmt
            .query_map([], row_to_kb)
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        Ok(rows)
    }

    pub fn create_knowledge_base(
        &self,
        name: &str,
        provider_id: Option<&str>,
        embed_model: Option<&str>,
    ) -> Result<KnowledgeBase, String> {
        let row = KnowledgeBase {
            id: new_id(),
            name: name.to_string(),
            provider_id: provider_id.map(|s| s.to_string()),
            embed_model: embed_model.map(|s| s.to_string()),
            dim: None,
            created_at: now_ms(),
        };
        self.lock()
            .execute(
                "INSERT INTO knowledge_bases (id, name, provider_id, embed_model, dim, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    row.id,
                    row.name,
                    row.provider_id,
                    row.embed_model,
                    row.dim,
                    row.created_at,
                ],
            )
            .map_err(e2s)?;
        Ok(row)
    }

    /// Patch a KB. Only the keys present in `patch` are changed — mirrors the
    /// frontend's `Partial<...>` semantics: an absent key keeps the current
    /// value, a present `null` clears it (provider_id / embed_model only).
    pub fn update_knowledge_base(&self, id: &str, patch: &serde_json::Value) -> Result<(), String> {
        let obj = match patch.as_object() {
            Some(o) => o,
            None => return Ok(()),
        };
        let conn = self.lock();
        let mut cur = conn
            .query_row(
                "SELECT id, name, provider_id, embed_model, dim, created_at \
                 FROM knowledge_bases WHERE id = ?1",
                params![id],
                row_to_kb,
            )
            .optional()
            .map_err(e2s)?;
        let Some(kb) = cur.take() else {
            return Ok(()); // unknown id — no-op, like the frontend's early return
        };
        // `null` JSON → None; a string → Some(string); absent key → keep current.
        let opt_str = |v: &serde_json::Value| v.as_str().map(|s| s.to_string());
        let name = match obj.get("name").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => kb.name,
        };
        let provider_id = match obj.get("provider_id") {
            Some(v) => opt_str(v),
            None => kb.provider_id,
        };
        let embed_model = match obj.get("embed_model") {
            Some(v) => opt_str(v),
            None => kb.embed_model,
        };
        conn.execute(
            "UPDATE knowledge_bases SET name = ?1, provider_id = ?2, embed_model = ?3 WHERE id = ?4",
            params![name, provider_id, embed_model, id],
        )
        .map_err(e2s)?;
        Ok(())
    }

    pub fn delete_knowledge_base(&self, id: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM knowledge_chunks WHERE kb_id = ?1", params![id])
            .map_err(e2s)?;
        conn.execute("DELETE FROM knowledge_bases WHERE id = ?1", params![id])
            .map_err(e2s)?;
        Ok(())
    }

    pub fn list_documents(&self, kb_id: &str) -> Result<Vec<DocSummary>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT doc_id, source, COUNT(*) AS chunks FROM knowledge_chunks \
                 WHERE kb_id = ?1 GROUP BY doc_id, source ORDER BY MAX(created_at) DESC",
            )
            .map_err(e2s)?;
        let rows = stmt
            .query_map(params![kb_id], |r| {
                Ok(DocSummary {
                    doc_id: r.get(0)?,
                    source: r.get(1)?,
                    chunks: r.get(2)?,
                })
            })
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        Ok(rows)
    }

    pub fn count_chunks(&self, kb_id: &str) -> Result<i64, String> {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM knowledge_chunks WHERE kb_id = ?1",
                params![kb_id],
                |r| r.get(0),
            )
            .map_err(e2s)
    }

    pub fn delete_document(&self, doc_id: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "DELETE FROM knowledge_chunks WHERE doc_id = ?1",
                params![doc_id],
            )
            .map(|_| ())
            .map_err(e2s)
    }

    /// Insert a batch of pre-embedded chunks under one document. Captures the
    /// KB's embedding dimensionality from the first non-empty vector if unset.
    /// Returns the number of chunks inserted.
    pub fn add_chunks(
        &self,
        kb_id: &str,
        doc_id: &str,
        source: &str,
        items: &[ChunkInput],
    ) -> Result<usize, String> {
        if items.is_empty() {
            return Ok(0);
        }
        let now = now_ms();
        let conn = self.lock();
        let mut dim: Option<i64> = conn
            .query_row(
                "SELECT dim FROM knowledge_bases WHERE id = ?1",
                params![kb_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(e2s)?
            .flatten();
        let dim_was_set = dim.is_some();
        for item in items {
            if dim.is_none() && !item.embedding.is_empty() {
                dim = Some(item.embedding.len() as i64);
            }
            let embedding_json = serde_json::to_string(&item.embedding).map_err(e2s)?;
            conn.execute(
                "INSERT INTO knowledge_chunks (id, kb_id, doc_id, source, text, embedding, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![new_id(), kb_id, doc_id, source, item.text, embedding_json, now],
            )
            .map_err(e2s)?;
        }
        if !dim_was_set {
            if let Some(d) = dim {
                conn.execute(
                    "UPDATE knowledge_bases SET dim = ?1 WHERE id = ?2",
                    params![d, kb_id],
                )
                .map_err(e2s)?;
            }
        }
        Ok(items.len())
    }

    /// Score every chunk in the KB against `query` by cosine and return the
    /// top-k positive hits. Brute force — fine at local-app scale, and avoids a
    /// native vector-index extension.
    pub fn search_knowledge(
        &self,
        kb_id: &str,
        query: &[f64],
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>, String> {
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT text, source, embedding FROM knowledge_chunks WHERE kb_id = ?1")
            .map_err(e2s)?;
        let mut rows = stmt.query(params![kb_id]).map_err(e2s)?;
        let mut scored: Vec<RetrievedChunk> = Vec::new();
        while let Some(row) = rows.next().map_err(e2s)? {
            let text: String = row.get(0).map_err(e2s)?;
            let source: String = row.get(1).map_err(e2s)?;
            let embedding_raw: String = row.get(2).map_err(e2s)?;
            let vec: Vec<f64> = serde_json::from_str(&embedding_raw).unwrap_or_default();
            let score = cosine(query, &vec);
            scored.push(RetrievedChunk {
                text,
                source,
                score,
            });
        }
        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.retain(|s| s.score > 0.0);
        scored.truncate(top_k);
        Ok(scored)
    }

    // ----- full-text search -----

    /// Run an FTS5 MATCH over `messages_fts` and return top hits with a snippet
    /// excerpt. `fts` is the already-built MATCH expression (the frontend quotes
    /// tokens + handles prefix `*`); a malformed expression surfaces as an Err
    /// the caller can swallow into an empty result, matching the old behavior.
    pub fn search_messages(&self, fts: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT m.id AS message_id, m.conversation_id AS conversation_id, \
                 c.title AS conversation_title, m.role AS role, \
                 snippet(messages_fts, 0, char(1), char(2), char(0x2026), 16) AS excerpt_raw, \
                 m.created_at AS created_at \
                 FROM messages_fts \
                 JOIN messages m ON m.rowid = messages_fts.rowid \
                 JOIN conversations c ON c.id = m.conversation_id \
                 WHERE messages_fts MATCH ?1 \
                 ORDER BY rank LIMIT ?2",
            )
            .map_err(e2s)?;
        let rows = stmt
            .query_map(params![fts, limit], |r| {
                Ok(SearchHit {
                    message_id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    conversation_title: r.get(2)?,
                    role: r.get(3)?,
                    excerpt_raw: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        Ok(rows)
    }

    // ----- JSON export / import -----

    /// Every conversation + its messages, oldest-first, for a self-contained
    /// JSON export. The frontend wraps this in the export envelope
    /// (schemaVersion / exportedAt / appVersion) and pretty-prints it.
    pub fn export_conversations(&self) -> Result<Vec<ExportedConversation>, String> {
        let conn = self.lock();
        let mut conv_stmt = conn
            .prepare(
                "SELECT id, title, created_at, updated_at, provider_id, model, \
                 temperature, pinned, max_tokens, system_prompt \
                 FROM conversations ORDER BY created_at ASC",
            )
            .map_err(e2s)?;
        let convos = conv_stmt
            .query_map([], row_to_conversation)
            .map_err(e2s)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e2s)?;
        let mut msg_stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, created_at, attachments, model \
                 FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(e2s)?;
        let mut out = Vec::with_capacity(convos.len());
        for c in convos {
            let messages = msg_stmt
                .query_map(params![c.id], row_to_message)
                .map_err(e2s)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(e2s)?
                .into_iter()
                .map(|m| ExportedMessage {
                    id: m.id,
                    role: m.role,
                    content: m.content,
                    created_at: m.created_at,
                    attachments: m.attachments,
                })
                .collect();
            out.push(ExportedConversation {
                id: c.id,
                title: c.title,
                created_at: c.created_at,
                updated_at: c.updated_at,
                provider_id: c.provider_id,
                model: c.model,
                temperature: c.temperature,
                pinned: Some(c.pinned.unwrap_or(0)),
                max_tokens: c.max_tokens,
                system_prompt: c.system_prompt,
                messages,
            });
        }
        Ok(out)
    }

    /// Insert conversations + messages from a (frontend-validated) export.
    /// Fresh UUIDs are minted so re-importing the same file produces independent
    /// copies instead of clobbering existing rows. Returns counts inserted.
    pub fn import_conversations(
        &self,
        convos: &[ExportedConversation],
    ) -> Result<ImportSummary, String> {
        let conn = self.lock();
        let mut conv_count = 0i64;
        let mut msg_count = 0i64;
        for c in convos {
            let new_conv_id = new_id();
            let title = if c.title.is_empty() {
                "Imported conversation".to_string()
            } else {
                c.title.clone()
            };
            // pinned: anything truthy → 1, else 0 (matches the frontend).
            let pinned = i64::from(c.pinned.unwrap_or(0) != 0);
            let max_tokens = c.max_tokens.filter(|m| *m > 0);
            let system_prompt = c.system_prompt.as_deref().filter(|s| !s.is_empty());
            conn.execute(
                "INSERT INTO conversations \
                 (id, title, created_at, updated_at, provider_id, model, temperature, pinned, max_tokens, system_prompt) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    new_conv_id,
                    title,
                    c.created_at,
                    c.updated_at,
                    c.provider_id,
                    c.model,
                    c.temperature,
                    pinned,
                    max_tokens,
                    system_prompt,
                ],
            )
            .map_err(e2s)?;
            conv_count += 1;
            for m in &c.messages {
                // Only store a non-empty attachment array, mirroring append_message.
                let attachments_json = match &m.attachments {
                    Some(serde_json::Value::Array(a)) if !a.is_empty() => {
                        Some(serde_json::to_string(&m.attachments).map_err(e2s)?)
                    }
                    _ => None,
                };
                conn.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![new_id(), new_conv_id, m.role, m.content, m.created_at, attachments_json],
                )
                .map_err(e2s)?;
                msg_count += 1;
            }
        }
        Ok(ImportSummary {
            conversations: conv_count,
            messages: msg_count,
        })
    }

    /// Wipe all user data (keeps the schema). Used by the "reset database"
    /// action — done in-connection rather than deleting the file so it works
    /// while the handle is open (Windows won't unlink an open SQLite file).
    pub fn reset(&self) -> Result<(), String> {
        let conn = self.lock();
        conn.execute_batch(
            "DELETE FROM knowledge_chunks; \
             DELETE FROM knowledge_bases; \
             DELETE FROM messages; \
             DELETE FROM conversations; \
             DELETE FROM kv; \
             INSERT INTO messages_fts(messages_fts) VALUES('rebuild');",
        )
        .map_err(e2s)?;
        conn.execute_batch("VACUUM;").map_err(e2s)?;
        Ok(())
    }

    // ----- generic SQL (escape hatch) -----
    //
    // Used by paths not yet converted to semantic ops (search / RAG / export).
    // Rows come back as JSON objects keyed by column name — same shape the old
    // tauri-plugin-sql bridge produced, so the frontend query code is unchanged.

    pub fn select_json(
        &self,
        sql: &str,
        params: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.lock();
        let mut stmt = conn.prepare(sql).map_err(e2s)?;
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let bound = to_sql_params(params);
        let mut rows = stmt
            .query(rusqlite::params_from_iter(bound.iter()))
            .map_err(e2s)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(e2s)? {
            let mut obj = serde_json::Map::with_capacity(cols.len());
            for (i, name) in cols.iter().enumerate() {
                let vref = row.get_ref(i).map_err(e2s)?;
                obj.insert(name.clone(), valueref_to_json(vref));
            }
            out.push(serde_json::Value::Object(obj));
        }
        Ok(out)
    }

    pub fn execute_sql(
        &self,
        sql: &str,
        params: &[serde_json::Value],
    ) -> Result<ExecResult, String> {
        let conn = self.lock();
        let bound = to_sql_params(params);
        let n = conn
            .execute(sql, rusqlite::params_from_iter(bound.iter()))
            .map_err(e2s)?;
        Ok(ExecResult {
            rows_affected: n as i64,
            last_insert_id: conn.last_insert_rowid(),
        })
    }
}

/// Mirrors tauri-plugin-sql's QueryResult so the frontend facade is unchanged.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: i64,
    pub last_insert_id: i64,
}

fn to_sql_params(params: &[serde_json::Value]) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value as V;
    params
        .iter()
        .map(|p| match p {
            serde_json::Value::Null => V::Null,
            serde_json::Value::Bool(b) => V::Integer(*b as i64),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    V::Integer(i)
                } else {
                    V::Real(n.as_f64().unwrap_or(0.0))
                }
            }
            serde_json::Value::String(s) => V::Text(s.clone()),
            other => V::Text(other.to_string()),
        })
        .collect()
}

fn valueref_to_json(v: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use rusqlite::types::ValueRef as R;
    match v {
        R::Null => serde_json::Value::Null,
        R::Integer(i) => serde_json::Value::from(i),
        R::Real(f) => serde_json::Value::from(f),
        R::Text(bytes) => serde_json::Value::from(String::from_utf8_lossy(bytes).into_owned()),
        R::Blob(_) => serde_json::Value::Null,
    }
}

// ---------- row mappers ----------

fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        provider_id: r.get(4)?,
        model: r.get(5)?,
        temperature: r.get(6)?,
        pinned: r.get(7)?,
        max_tokens: r.get(8)?,
        system_prompt: r.get(9)?,
    })
}

fn row_to_kb(r: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeBase> {
    Ok(KnowledgeBase {
        id: r.get(0)?,
        name: r.get(1)?,
        provider_id: r.get(2)?,
        embed_model: r.get(3)?,
        dim: r.get(4)?,
        created_at: r.get(5)?,
    })
}

/// Cosine similarity over the shared prefix of two vectors (matches the old JS
/// implementation, which also clamped to `min(len)`).
fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let attachments_raw: Option<String> = r.get(5)?;
    let attachments = attachments_raw
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    Ok(Message {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        role: r.get(2)?,
        content: r.get(3)?,
        created_at: r.get(4)?,
        attachments,
        model: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_and_round_trip() {
        let db = Db::open_in_memory().expect("open");

        // user_version should reflect the full chain.
        {
            let conn = db.lock();
            let v: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v as usize, MIGRATIONS.len());
        }

        // Conversation create/list.
        let c = db
            .create_conversation("Hello", &ConversationInit::default())
            .unwrap();
        let list = db.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, c.id);
        assert_eq!(list[0].pinned, Some(0));

        // Messages append/list, attachments round-trip.
        db.append_message(&c.id, "user", "hi", None, None).unwrap();
        let atts = serde_json::json!([{ "id": "a1", "type": "image", "name": "x.png" }]);
        db.append_message(&c.id, "assistant", "yo", Some(atts.clone()), Some("gpt-4o"))
            .unwrap();
        let msgs = db.list_messages(&c.id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].attachments, None);
        assert_eq!(msgs[1].attachments, Some(atts));

        // Empty attachment array normalizes to None.
        db.append_message(&c.id, "user", "empty", Some(serde_json::json!([])), None)
            .unwrap();
        let msgs = db.list_messages(&c.id).unwrap();
        assert_eq!(msgs[2].attachments, None);

        // FTS index is queryable (sync trigger works).
        {
            let conn = db.lock();
            let hits: i64 = conn
                .query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'hi'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(hits, 1);
        }

        // KV round-trip.
        db.kv_set("locale", &serde_json::json!("zh")).unwrap();
        assert_eq!(db.kv_get("locale").unwrap(), Some(serde_json::json!("zh")));
        db.kv_delete("locale").unwrap();
        assert_eq!(db.kv_get("locale").unwrap(), None);

        // Delete conversation cascades messages.
        db.delete_conversation(&c.id).unwrap();
        assert_eq!(db.list_conversations().unwrap().len(), 0);
        assert_eq!(db.list_messages(&c.id).unwrap().len(), 0);
    }

    #[test]
    fn generic_sql_round_trip() {
        let db = Db::open_in_memory().unwrap();
        let c = db
            .create_conversation("g", &ConversationInit::default())
            .unwrap();
        let rows = db
            .select_json(
                "SELECT id, title FROM conversations WHERE id = ?1",
                &[serde_json::json!(c.id)],
            )
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], serde_json::json!("g"));
        let res = db
            .execute_sql(
                "UPDATE conversations SET title = ?1 WHERE id = ?2",
                &[serde_json::json!("g2"), serde_json::json!(c.id)],
            )
            .unwrap();
        assert_eq!(res.rows_affected, 1);
    }

    #[test]
    fn rag_round_trip() {
        let db = Db::open_in_memory().unwrap();
        let kb = db
            .create_knowledge_base("KB", Some("openai"), Some("text-embedding-3-small"))
            .unwrap();
        assert_eq!(db.list_knowledge_bases().unwrap().len(), 1);
        assert_eq!(kb.dim, None);

        // Index two chunks under one doc; dim captured from the first vector.
        let items = vec![
            ChunkInput {
                text: "alpha".into(),
                embedding: vec![1.0, 0.0],
            },
            ChunkInput {
                text: "beta".into(),
                embedding: vec![0.0, 1.0],
            },
        ];
        let n = db.add_chunks(&kb.id, "doc1", "notes.md", &items).unwrap();
        assert_eq!(n, 2);
        assert_eq!(db.count_chunks(&kb.id).unwrap(), 2);
        // dim is now set on the KB.
        let kb2 = db
            .list_knowledge_bases()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(kb2.dim, Some(2));

        // Document listing groups by doc.
        let docs = db.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].doc_id, "doc1");
        assert_eq!(docs[0].chunks, 2);

        // Search: query close to "alpha" ranks it first, positive score only.
        let hits = db.search_knowledge(&kb.id, &[1.0, 0.0], 5).unwrap();
        assert_eq!(hits.len(), 1); // beta is orthogonal → score 0, filtered out
        assert_eq!(hits[0].text, "alpha");
        assert!(hits[0].score > 0.99);

        // Patch semantics: present key changes, absent key untouched.
        db.update_knowledge_base(&kb.id, &serde_json::json!({ "name": "Renamed" }))
            .unwrap();
        db.update_knowledge_base(&kb.id, &serde_json::json!({ "embed_model": null }))
            .unwrap();
        let kb3 = db
            .list_knowledge_bases()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(kb3.name, "Renamed");
        assert_eq!(kb3.embed_model, None);
        assert_eq!(kb3.provider_id.as_deref(), Some("openai")); // untouched

        // Delete the document, then the KB (cascade chunks).
        db.delete_document("doc1").unwrap();
        assert_eq!(db.count_chunks(&kb.id).unwrap(), 0);
        db.delete_knowledge_base(&kb.id).unwrap();
        assert_eq!(db.list_knowledge_bases().unwrap().len(), 0);
    }

    #[test]
    fn search_and_export_import_round_trip() {
        let db = Db::open_in_memory().unwrap();
        let c = db
            .create_conversation("Trip", &ConversationInit::default())
            .unwrap();
        db.append_message(&c.id, "user", "hello kangaroo", None, None)
            .unwrap();
        db.append_message(&c.id, "assistant", "the kangaroo hops", None, None)
            .unwrap();

        // FTS: prefix match on a quoted token, snippet markers present.
        let hits = db.search_messages("\"kangaroo\"", 50).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.conversation_title == "Trip"));
        assert!(hits[0].excerpt_raw.contains('\u{1}')); // <b> marker byte
                                                        // Malformed MATCH surfaces as an Err (caller swallows it).
        assert!(db.search_messages("AND", 50).is_err());

        // Export captures both messages under the one conversation.
        let exported = db.export_conversations().unwrap();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].messages.len(), 2);
        assert_eq!(exported[0].title, "Trip");

        // Import mints fresh ids → additive (now two conversations, four msgs).
        let summary = db.import_conversations(&exported).unwrap();
        assert_eq!(summary.conversations, 1);
        assert_eq!(summary.messages, 2);
        assert_eq!(db.list_conversations().unwrap().len(), 2);
        let total_hits = db.search_messages("\"kangaroo\"", 50).unwrap();
        assert_eq!(total_hits.len(), 4);
    }

    #[test]
    fn adopts_existing_plugin_sql_db() {
        // Simulate a DB migrated by plugin-sql: full v8 schema but
        // user_version still 0 (plugin-sql tracks elsewhere).
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..8] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch("PRAGMA user_version = 0;").unwrap();
        // Re-running must not error on the non-idempotent ALTERs; it should
        // detect baseline 8 and apply only v9 (kv).
        run_migrations(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        assert!(table_exists(&conn, "kv"));
    }
}

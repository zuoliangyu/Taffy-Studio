// Shared entry for desktop and mobile. Tauri's mobile target generates a
// platform-specific main that calls into this `run` function — keep all
// builder setup here so the two targets stay identical.

mod mcp;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::sync::Mutex;

use mcp::{McpServerConfig, McpState, McpTool};

/// A tool the chat layer can offer to the model. Mirrors mcp::McpTool but is
/// the shape the frontend sends on a ChatRequest — it already knows which
/// server owns each tool from the connect() response.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub server_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Max agentic tool-use rounds before we force a final answer. Guards against a
/// model that keeps calling tools forever.
const MAX_TOOL_ROUNDS: usize = 8;

const DB_FILE: &str = "taffy-studio.db";
const MAX_BACKUPS: usize = 7;

// ---------- DTOs (JS <-> Rust) ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Per-attachment uuid (frontend-generated).
    pub id: String,
    /// "image" — we only send these to the LLM in this MVP.
    /// Future: "file" with a server-side file-upload step per provider.
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// Base64-encoded payload (no `data:` URL prefix).
    pub data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// "openai" | "anthropic" | "gemini" | "deepseek" | "siliconflow" |
    /// "ollama" | "custom" — anything not anthropic/gemini is treated as
    /// OpenAI-compatible.
    pub provider: String,
    /// Endpoint root. Defaults per provider if omitted.
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    /// Required by Anthropic. Used as a sane default elsewhere.
    pub max_tokens: Option<u32>,
    /// Optional caller-provided id so the JS side can cancel by handle.
    pub stream_id: Option<String>,
    /// Tools the model may call this turn (MCP-backed). When present and
    /// non-empty on a supported provider, chat_stream runs the agentic
    /// tool-use loop instead of a plain stream.
    #[serde(default)]
    pub tools: Option<Vec<ToolSpec>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token {
        content: String,
    },
    Done {
        content: String,
        model: String,
    },
    Error {
        message: String,
    },
    Cancelled {
        content: String,
    },
    /// The model asked to call a tool; surfaced so the UI can show activity.
    ToolCall {
        id: String,
        server_id: String,
        name: String,
        args: String,
    },
    /// A tool finished; `result` is the (possibly truncated) text it returned.
    ToolResult {
        id: String,
        name: String,
        result: String,
    },
}

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

fn provider_kind(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" => "gemini",
        _ => "openai", // openai-compatible (openai, deepseek, siliconflow, ollama, ...)
    }
}

fn default_base_url(kind: &str) -> &'static str {
    match kind {
        "anthropic" => "https://api.anthropic.com",
        "gemini" => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com/v1",
    }
}

// Build the system text by extracting consecutive leading system messages.
// Anthropic + Gemini require system content out of the messages array.
fn split_system(msgs: &[ChatMessage]) -> (String, Vec<&ChatMessage>) {
    let mut sys = String::new();
    let mut rest: Vec<&ChatMessage> = Vec::with_capacity(msgs.len());
    for m in msgs {
        if rest.is_empty() && m.role == "system" {
            if !sys.is_empty() {
                sys.push_str("\n\n");
            }
            sys.push_str(&m.content);
        } else {
            rest.push(m);
        }
    }
    (sys, rest)
}

// ---------- Stream loop helpers ----------

#[derive(Debug)]
enum Sse {
    Data(String),
    Done,
    Other, // event:, id:, comment lines etc.
}

fn parse_sse_line(line: &str) -> Sse {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() {
        return Sse::Other;
    }
    let Some(data) = line.strip_prefix("data:") else {
        return Sse::Other;
    };
    let data = data.trim();
    if data == "[DONE]" {
        Sse::Done
    } else {
        Sse::Data(data.to_string())
    }
}

/// Try to extract incremental text from one SSE data frame, given the provider.
fn extract_delta(kind: &str, json: &serde_json::Value) -> Option<String> {
    match kind {
        "anthropic" => {
            // event types we care about: content_block_delta with text_delta
            let t = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if t == "content_block_delta" {
                json.pointer("/delta/text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        }
        "gemini" => json
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        _ => json
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

/// Anthropic uses `stop_reason: "end_turn"` on `message_delta`; OpenAI uses
/// `[DONE]`. Gemini ends on stream EOF. We treat any of those as success.
fn is_terminal(kind: &str, json: &serde_json::Value) -> bool {
    match kind {
        "anthropic" => {
            let t = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
            t == "message_stop"
        }
        _ => false,
    }
}

// ---------- Build per-provider HTTP request ----------

/// Only image/* attachments are sent to the LLM right now. Other types are
/// stored in the DB but skipped on the wire (and the UI flags them).
fn image_attachments(atts: &[Attachment]) -> impl Iterator<Item = &Attachment> {
    atts.iter()
        .filter(|a| a.kind == "image" && a.mime.starts_with("image/"))
}

fn openai_message(m: &ChatMessage) -> serde_json::Value {
    let imgs: Vec<&Attachment> = image_attachments(&m.attachments).collect();
    if imgs.is_empty() {
        return serde_json::json!({ "role": m.role, "content": m.content });
    }
    let mut parts: Vec<serde_json::Value> = Vec::with_capacity(1 + imgs.len());
    if !m.content.is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": m.content }));
    }
    for a in imgs {
        parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", a.mime, a.data) },
        }));
    }
    serde_json::json!({ "role": m.role, "content": parts })
}

fn anthropic_message(m: &ChatMessage) -> serde_json::Value {
    let imgs: Vec<&Attachment> = image_attachments(&m.attachments).collect();
    let role = if m.role == "assistant" {
        "assistant"
    } else {
        "user"
    };
    if imgs.is_empty() {
        return serde_json::json!({ "role": role, "content": m.content });
    }
    let mut parts: Vec<serde_json::Value> = Vec::with_capacity(1 + imgs.len());
    // Anthropic prefers images BEFORE text — improves grounding.
    for a in imgs {
        parts.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": a.mime,
                "data": a.data,
            },
        }));
    }
    if !m.content.is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": m.content }));
    }
    serde_json::json!({ "role": role, "content": parts })
}

fn gemini_message(m: &ChatMessage) -> serde_json::Value {
    let role = if m.role == "assistant" {
        "model"
    } else {
        "user"
    };
    let mut parts: Vec<serde_json::Value> = Vec::new();
    if !m.content.is_empty() {
        parts.push(serde_json::json!({ "text": m.content }));
    }
    for a in image_attachments(&m.attachments) {
        parts.push(serde_json::json!({
            "inline_data": { "mime_type": a.mime, "data": a.data },
        }));
    }
    serde_json::json!({ "role": role, "parts": parts })
}

fn build_request(
    client: &reqwest::Client,
    req: &ChatRequest,
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let kind = provider_kind(&req.provider);
    let base = req
        .base_url
        .clone()
        .unwrap_or_else(|| default_base_url(kind).to_string());
    let base = base.trim_end_matches('/').to_string();
    let key = req.api_key.as_deref().unwrap_or("");

    let (url, body, mut headers) = match kind {
        "anthropic" => {
            let url = format!("{}/v1/messages", base);
            let (sys, rest) = split_system(&req.messages);
            let messages_json: Vec<_> = rest.iter().map(|m| anthropic_message(m)).collect();
            let mut body = serde_json::json!({
                "model": req.model,
                "messages": messages_json,
                "max_tokens": req.max_tokens.unwrap_or(4096),
                "stream": stream,
            });
            if !sys.is_empty() {
                body["system"] = serde_json::Value::String(sys);
            }
            if let Some(t) = req.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                "x-api-key",
                key.parse()
                    .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
            );
            h.insert("anthropic-version", "2023-06-01".parse().unwrap());
            (url, body, h)
        }
        "gemini" => {
            // streamGenerateContent with ?alt=sse pushes server-sent events.
            let url = if stream {
                format!(
                    "{}/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                    base, req.model, key
                )
            } else {
                format!(
                    "{}/v1beta/models/{}:generateContent?key={}",
                    base, req.model, key
                )
            };

            let (sys, rest) = split_system(&req.messages);
            let contents: Vec<_> = rest.iter().map(|m| gemini_message(m)).collect();
            let mut body = serde_json::json!({ "contents": contents });
            if !sys.is_empty() {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{ "text": sys }]
                });
            }
            let mut gen_config = serde_json::Map::new();
            if let Some(t) = req.temperature {
                gen_config.insert("temperature".into(), serde_json::json!(t));
            }
            if let Some(mt) = req.max_tokens {
                gen_config.insert("maxOutputTokens".into(), serde_json::json!(mt));
            }
            if !gen_config.is_empty() {
                body["generationConfig"] = serde_json::Value::Object(gen_config);
            }
            (url, body, reqwest::header::HeaderMap::new())
        }
        _ => {
            let url = format!("{}/chat/completions", base);
            let messages_json: Vec<_> = req.messages.iter().map(openai_message).collect();
            let mut body = serde_json::json!({
                "model": req.model,
                "messages": messages_json,
                "stream": stream,
            });
            if let Some(t) = req.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            if let Some(mt) = req.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
            let mut h = reqwest::header::HeaderMap::new();
            if !key.is_empty() {
                h.insert(
                    "authorization",
                    format!("Bearer {}", key)
                        .parse()
                        .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
                );
            }
            (url, body, h)
        }
    };

    headers.insert("content-type", "application/json".parse().unwrap());

    Ok(client.post(&url).headers(headers).json(&body))
}

// ---------- Commands ----------

/// Fetch the available model list for a provider. Anthropic doesn't expose a
/// model listing endpoint in some accounts, so we fall back to a curated set.
#[tauri::command]
async fn list_models(req: ChatRequest) -> Result<Vec<String>, String> {
    let kind = provider_kind(&req.provider);
    let base = req
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(kind))
        .trim_end_matches('/')
        .to_string();
    let key = req.api_key.as_deref().unwrap_or("");

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    match kind {
        "anthropic" => {
            let url = format!("{}/v1/models", base);
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                "x-api-key",
                key.parse()
                    .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
            );
            h.insert("anthropic-version", "2023-06-01".parse().unwrap());
            if let Ok(r) = client.get(&url).headers(h).send().await {
                if r.status().is_success() {
                    if let Ok(json) = r.json::<serde_json::Value>().await {
                        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
                            let ids: Vec<String> = arr
                                .iter()
                                .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
                                .map(|s| s.to_string())
                                .collect();
                            if !ids.is_empty() {
                                return Ok(ids);
                            }
                        }
                    }
                }
            }
            // Curated fallback (used only if /v1/models is unreachable).
            Ok(vec![
                "claude-sonnet-4-6".into(),
                "claude-opus-4-1-20250805".into(),
                "claude-sonnet-4-5".into(),
                "claude-sonnet-4-20250514".into(),
                "claude-3-7-sonnet-latest".into(),
                "claude-3-5-sonnet-latest".into(),
                "claude-3-5-haiku-latest".into(),
            ])
        }
        "gemini" => {
            let url = format!("{}/v1beta/models?key={}", base, key);
            let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let s = resp.status();
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("HTTP {}: {}", s, t));
            }
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let arr = json
                .get("models")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "missing 'models' in response".to_string())?;
            let ids: Vec<String> = arr
                .iter()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()))
                .map(|s| s.strip_prefix("models/").unwrap_or(s).to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(ids)
        }
        _ => {
            // OpenAI-compatible: GET {base}/models  with Bearer auth.
            let url = format!("{}/models", base);
            let mut req_b = client.get(&url);
            if !key.is_empty() {
                req_b = req_b.bearer_auth(key);
            }
            let resp = req_b.send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let s = resp.status();
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("HTTP {}: {}", s, t));
            }
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let arr = json
                .get("data")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "missing 'data' in response".to_string())?;
            let ids: Vec<String> = arr
                .iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect();
            Ok(ids)
        }
    }
}

#[tauri::command]
async fn chat_complete(req: ChatRequest) -> Result<ChatResponse, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let request = build_request(&client, &req, false)?;
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    let kind = provider_kind(&req.provider);
    let content = match kind {
        "anthropic" => {
            // content is an array: [{type:"text", text:"..."}, ...]
            json.pointer("/content/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        "gemini" => json
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => json
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(&req.model)
        .to_string();
    Ok(ChatResponse { content, model })
}

#[tauri::command]
async fn chat_stream(
    req: ChatRequest,
    on_event: Channel<StreamEvent>,
    state: State<'_, Cancellation>,
    mcp_state: State<'_, McpState>,
) -> Result<(), String> {
    // Agentic path: tools attached + a provider that supports tool use →
    // run the multi-round loop. Gemini tool-use isn't wired yet, so it falls
    // through to a normal stream (tools ignored).
    if let Some(tools) = req.tools.clone() {
        if !tools.is_empty() {
            let kind = provider_kind(&req.provider);
            if kind == "openai" || kind == "anthropic" {
                return run_agentic(&req, &tools, on_event, &state, &mcp_state).await;
            }
        }
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    // Register cancellation token if caller gave us a stream_id.
    let token = if let Some(id) = req.stream_id.as_deref() {
        Some((id.to_string(), register_token(&state, id).await))
    } else {
        None
    };

    let kind = provider_kind(&req.provider).to_string();

    let request = match build_request(&client, &req, true) {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error { message: e.clone() });
            if let Some((id, _)) = &token {
                unregister_token(&state, id).await;
            }
            return Err(e);
        }
    };

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            let _ = on_event.send(StreamEvent::Error {
                message: msg.clone(),
            });
            if let Some((id, _)) = &token {
                unregister_token(&state, id).await;
            }
            return Err(msg);
        }
    };

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let msg = format!("HTTP {}: {}", status, text);
        let _ = on_event.send(StreamEvent::Error {
            message: msg.clone(),
        });
        if let Some((id, _)) = &token {
            unregister_token(&state, id).await;
        }
        return Err(msg);
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full = String::new();

    while let Some(chunk) = stream.next().await {
        // Cancellation check before doing anything with the new chunk.
        if let Some((_, tok)) = &token {
            if tok.load(Ordering::SeqCst) {
                let _ = on_event.send(StreamEvent::Cancelled {
                    content: std::mem::take(&mut full),
                });
                if let Some((id, _)) = &token {
                    unregister_token(&state, id).await;
                }
                return Ok(());
            }
        }

        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let msg = format!("stream error: {e}");
                let _ = on_event.send(StreamEvent::Error {
                    message: msg.clone(),
                });
                if let Some((id, _)) = &token {
                    unregister_token(&state, id).await;
                }
                return Err(msg);
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(nl) = buffer.find('\n') {
            let line: String = buffer.drain(..=nl).collect();
            match parse_sse_line(&line) {
                Sse::Other => continue,
                Sse::Done => {
                    let _ = on_event.send(StreamEvent::Done {
                        content: std::mem::take(&mut full),
                        model: req.model.clone(),
                    });
                    if let Some((id, _)) = &token {
                        unregister_token(&state, id).await;
                    }
                    return Ok(());
                }
                Sse::Data(data) => {
                    let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) else {
                        continue;
                    };
                    if is_terminal(&kind, &json) {
                        let _ = on_event.send(StreamEvent::Done {
                            content: std::mem::take(&mut full),
                            model: req.model.clone(),
                        });
                        if let Some((id, _)) = &token {
                            unregister_token(&state, id).await;
                        }
                        return Ok(());
                    }
                    if let Some(c) = extract_delta(&kind, &json) {
                        if !c.is_empty() {
                            full.push_str(&c);
                            // Also poll cancellation between fine-grained events.
                            if let Some((_, tok)) = &token {
                                if tok.load(Ordering::SeqCst) {
                                    let _ = on_event.send(StreamEvent::Cancelled {
                                        content: std::mem::take(&mut full),
                                    });
                                    if let Some((id, _)) = &token {
                                        unregister_token(&state, id).await;
                                    }
                                    return Ok(());
                                }
                            }
                            let _ = on_event.send(StreamEvent::Token { content: c });
                        }
                    }
                }
            }
            // Fall through to consume the next \n-delimited line in buffer.
        }
    }

    // Stream closed cleanly without an explicit terminator.
    let _ = on_event.send(StreamEvent::Done {
        content: full,
        model: req.model.clone(),
    });
    if let Some((id, _)) = &token {
        unregister_token(&state, id).await;
    }
    Ok(())
}

// ---------- Agentic tool-use loop ----------
//
// When a request carries `tools`, we run a non-streaming round loop instead of
// the token stream: ask the model (with tools), execute any tool calls via the
// MCP layer, feed the results back, and repeat until the model answers without
// calling a tool (or we hit MAX_TOOL_ROUNDS). The final assistant text is
// emitted as a single Token + Done so the existing UI path renders it. Tool
// activity surfaces as ToolCall / ToolResult events.

const TOOL_RESULT_UI_CAP: usize = 4000;

fn truncate_for_ui(s: &str) -> String {
    if s.len() <= TOOL_RESULT_UI_CAP {
        return s.to_string();
    }
    let mut end = TOOL_RESULT_UI_CAP;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [{} bytes total]", &s[..end], s.len())
}

fn tool_server_for<'a>(tools: &'a [ToolSpec], name: &str) -> Option<&'a ToolSpec> {
    tools.iter().find(|t| t.name == name)
}

async fn exec_tool(
    tools: &[ToolSpec],
    mcp_state: &McpState,
    name: &str,
    args: serde_json::Value,
) -> String {
    match tool_server_for(tools, name) {
        Some(t) => mcp::call_tool(mcp_state, &t.server_id, name, args)
            .await
            .unwrap_or_else(|e| format!("ERROR: {e}")),
        None => format!("ERROR: tool '{name}' is not connected"),
    }
}

async fn run_agentic(
    req: &ChatRequest,
    tools: &[ToolSpec],
    on_event: Channel<StreamEvent>,
    cancel: &State<'_, Cancellation>,
    mcp_state: &McpState,
) -> Result<(), String> {
    let token = if let Some(id) = req.stream_id.as_deref() {
        Some((id.to_string(), register_token(cancel, id).await))
    } else {
        None
    };
    let flag = token.as_ref().map(|(_, t)| t.clone());

    let result = agentic_inner(req, tools, &on_event, mcp_state, flag).await;

    if let Some((id, _)) = &token {
        unregister_token(cancel, id).await;
    }
    result
}

async fn agentic_inner(
    req: &ChatRequest,
    tools: &[ToolSpec],
    on_event: &Channel<StreamEvent>,
    mcp_state: &McpState,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let kind = provider_kind(&req.provider).to_string();
    let base = req
        .base_url
        .clone()
        .unwrap_or_else(|| default_base_url(&kind).to_string());
    let base = base.trim_end_matches('/').to_string();
    let key = req.api_key.as_deref().unwrap_or("");

    let cancelled = || -> bool {
        cancel_flag
            .as_ref()
            .map(|f| f.load(Ordering::SeqCst))
            .unwrap_or(false)
    };

    let mut full = String::new();

    if kind == "anthropic" {
        let (sys, rest) = split_system(&req.messages);
        let mut messages: Vec<serde_json::Value> =
            rest.iter().map(|m| anthropic_message(m)).collect();
        let tools_json: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();

        for _ in 0..MAX_TOOL_ROUNDS {
            if cancelled() {
                let _ = on_event.send(StreamEvent::Cancelled {
                    content: std::mem::take(&mut full),
                });
                return Ok(());
            }

            let mut body = serde_json::json!({
                "model": req.model,
                "messages": messages,
                "max_tokens": req.max_tokens.unwrap_or(4096),
                "tools": tools_json,
                "stream": false,
            });
            if !sys.is_empty() {
                body["system"] = serde_json::Value::String(sys.clone());
            }
            if let Some(t) = req.temperature {
                body["temperature"] = serde_json::json!(t);
            }

            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                "x-api-key",
                key.parse()
                    .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
            );
            h.insert("anthropic-version", "2023-06-01".parse().unwrap());
            h.insert("content-type", "application/json".parse().unwrap());

            let resp = client
                .post(format!("{base}/v1/messages"))
                .headers(h)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string());
            let json = match read_json_or_emit(resp, on_event).await {
                Ok(j) => j,
                Err(e) => return Err(e),
            };

            let blocks = json
                .get("content")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let stop = json
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let mut tool_uses: Vec<serde_json::Value> = Vec::new();
            for b in &blocks {
                match b.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                full.push_str(t);
                                let _ = on_event.send(StreamEvent::Token { content: t.into() });
                            }
                        }
                    }
                    Some("tool_use") => tool_uses.push(b.clone()),
                    _ => {}
                }
            }

            if stop != "tool_use" || tool_uses.is_empty() {
                let _ = on_event.send(StreamEvent::Done {
                    content: std::mem::take(&mut full),
                    model: req.model.clone(),
                });
                return Ok(());
            }

            messages.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            let mut results: Vec<serde_json::Value> = Vec::new();
            for tu in &tool_uses {
                let id = tu
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = tu
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = tu.get("input").cloned().unwrap_or(serde_json::json!({}));
                let _ = on_event.send(StreamEvent::ToolCall {
                    id: id.clone(),
                    server_id: tool_server_for(tools, &name)
                        .map(|t| t.server_id.clone())
                        .unwrap_or_default(),
                    name: name.clone(),
                    args: input.to_string(),
                });
                let out = exec_tool(tools, mcp_state, &name, input).await;
                let _ = on_event.send(StreamEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    result: truncate_for_ui(&out),
                });
                results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": out,
                }));
            }
            messages.push(serde_json::json!({ "role": "user", "content": results }));
        }
    } else {
        // OpenAI-compatible.
        let mut messages: Vec<serde_json::Value> =
            req.messages.iter().map(openai_message).collect();
        let tools_json: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                })
            })
            .collect();

        for _ in 0..MAX_TOOL_ROUNDS {
            if cancelled() {
                let _ = on_event.send(StreamEvent::Cancelled {
                    content: std::mem::take(&mut full),
                });
                return Ok(());
            }

            let mut body = serde_json::json!({
                "model": req.model,
                "messages": messages,
                "tools": tools_json,
                "stream": false,
            });
            if let Some(t) = req.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            if let Some(mt) = req.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }

            let mut h = reqwest::header::HeaderMap::new();
            if !key.is_empty() {
                h.insert(
                    "authorization",
                    format!("Bearer {key}")
                        .parse()
                        .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
                );
            }
            h.insert("content-type", "application/json".parse().unwrap());

            let resp = client
                .post(format!("{base}/chat/completions"))
                .headers(h)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string());
            let json = match read_json_or_emit(resp, on_event).await {
                Ok(j) => j,
                Err(e) => return Err(e),
            };

            let msg = json
                .pointer("/choices/0/message")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if !content.is_empty() {
                full.push_str(content);
                let _ = on_event.send(StreamEvent::Token {
                    content: content.into(),
                });
            }

            let tool_calls = msg
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if tool_calls.is_empty() {
                let _ = on_event.send(StreamEvent::Done {
                    content: std::mem::take(&mut full),
                    model: req.model.clone(),
                });
                return Ok(());
            }

            messages.push(msg.clone());
            for tc in &tool_calls {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = tc
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = tc
                    .pointer("/function/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string();
                let _ = on_event.send(StreamEvent::ToolCall {
                    id: id.clone(),
                    server_id: tool_server_for(tools, &name)
                        .map(|t| t.server_id.clone())
                        .unwrap_or_default(),
                    name: name.clone(),
                    args: args_str.clone(),
                });
                let args_val: serde_json::Value =
                    serde_json::from_str(&args_str).unwrap_or(serde_json::json!({}));
                let out = exec_tool(tools, mcp_state, &name, args_val).await;
                let _ = on_event.send(StreamEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    result: truncate_for_ui(&out),
                });
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": out,
                }));
            }
        }
    }

    // Ran out of rounds — emit whatever we have so the user isn't left hanging.
    let _ = on_event.send(StreamEvent::Done {
        content: std::mem::take(&mut full),
        model: req.model.clone(),
    });
    Ok(())
}

/// Shared helper: turn a reqwest send-result into parsed JSON, emitting an
/// Error stream event (and returning Err) on transport / HTTP / parse failure.
async fn read_json_or_emit(
    resp: Result<reqwest::Response, String>,
    on_event: &Channel<StreamEvent>,
) -> Result<serde_json::Value, String> {
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("HTTP {status}: {text}");
        let _ = on_event.send(StreamEvent::Error {
            message: msg.clone(),
        });
        return Err(msg);
    }
    match resp.json::<serde_json::Value>().await {
        Ok(j) => Ok(j),
        Err(e) => {
            let msg = e.to_string();
            let _ = on_event.send(StreamEvent::Error {
                message: msg.clone(),
            });
            Err(msg)
        }
    }
}

// ---------- MCP commands ----------

#[tauri::command]
async fn mcp_connect(
    config: McpServerConfig,
    state: State<'_, McpState>,
) -> Result<Vec<McpTool>, String> {
    mcp::connect(&state, config).await
}

#[tauri::command]
async fn mcp_disconnect(id: String, state: State<'_, McpState>) -> Result<(), String> {
    mcp::disconnect(&state, &id).await;
    Ok(())
}

#[tauri::command]
async fn mcp_list_tools(state: State<'_, McpState>) -> Result<Vec<McpTool>, String> {
    Ok(mcp::all_tools(&state).await)
}

#[tauri::command]
async fn mcp_call_tool(
    server_id: String,
    name: String,
    args: serde_json::Value,
    state: State<'_, McpState>,
) -> Result<String, String> {
    mcp::call_tool(&state, &server_id, &name, args).await
}

// ---------- Embeddings (RAG) ----------
//
// One HTTP call to an OpenAI-compatible /embeddings endpoint. Keeping it in
// Rust matches the rest of the app: the API key never reaches the webview.
// The vector store + cosine search live on the JS side (see src/lib/rag.ts);
// for the local-app scale (thousands of chunks) a brute-force cosine in JS is
// plenty, and it avoids a native sqlite-vec extension dependency.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedRequest {
    pub provider: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub input: Vec<String>,
}

#[tauri::command]
async fn embed_texts(req: EmbedRequest) -> Result<Vec<Vec<f32>>, String> {
    if req.input.is_empty() {
        return Ok(vec![]);
    }
    let kind = provider_kind(&req.provider);
    let base = req
        .base_url
        .clone()
        .unwrap_or_else(|| default_base_url(kind).to_string());
    let base = base.trim_end_matches('/').to_string();
    let key = req.api_key.as_deref().unwrap_or("");
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    if kind == "gemini" {
        // Gemini batchEmbedContents — one request, many texts.
        let url = format!(
            "{base}/v1beta/models/{}:batchEmbedContents?key={key}",
            req.model
        );
        let requests: Vec<serde_json::Value> = req
            .input
            .iter()
            .map(|t| {
                serde_json::json!({
                    "model": format!("models/{}", req.model),
                    "content": { "parts": [{ "text": t }] }
                })
            })
            .collect();
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "requests": requests }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {s}: {t}"));
        }
        let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let arr = j
            .get("embeddings")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "missing 'embeddings' in response".to_string())?;
        let out = arr
            .iter()
            .map(|e| {
                e.pointer("/values")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_f64().map(|f| f as f32))
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect();
        return Ok(out);
    }

    // OpenAI-compatible /embeddings (also covers SiliconFlow, etc.).
    let url = format!("{base}/embeddings");
    let mut rb = client.post(&url).json(&serde_json::json!({
        "model": req.model,
        "input": req.input,
    }));
    if !key.is_empty() {
        rb = rb.bearer_auth(key);
    }
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let s = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {s}: {t}"));
    }
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = j
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing 'data' in embeddings response".to_string())?;
    let out = arr
        .iter()
        .map(|e| {
            e.get("embedding")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_f64().map(|f| f as f32))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    Ok(out)
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
fn reset_database(app: AppHandle) -> Result<(), String> {
    let db = db_path(&app)?;
    let dir = backups_dir(&app)?;
    // Belt-and-suspenders: take one more snapshot before nuking.
    if db.exists() {
        let _ = copy_backup(&db, &dir);
        prune_backups(&dir, MAX_BACKUPS + 1);
    }
    for ext in ["", "-wal", "-shm"] {
        let p = db.with_file_name(format!("{}{}", DB_FILE, ext));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

// ---------- DB migrations ----------

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: r#"
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
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add attachments column",
            // JSON-encoded array of {id, type, name, mime, size, data(base64)}.
            // Null when there are no attachments to keep existing rows cheap.
            sql: "ALTER TABLE messages ADD COLUMN attachments TEXT NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add per-conversation provider + model",
            // NULL means "use the global default provider / its default model".
            // Both must be NULLABLE so older conversations keep working unchanged.
            sql: "ALTER TABLE conversations ADD COLUMN provider_id TEXT NULL;\
                  ALTER TABLE conversations ADD COLUMN model TEXT NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add per-conversation temperature",
            // REAL NULL — NULL means "use the global default temperature".
            sql: "ALTER TABLE conversations ADD COLUMN temperature REAL NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add conversation pin flag",
            // 0 / 1, defaulted so existing rows are explicitly unpinned. Used
            // by the sidebar to bubble pinned rows above the recency sort.
            sql: "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add per-conversation max_tokens + system_prompt",
            // Both NULL by default: max_tokens NULL = let Rust dispatch decide
            // (Anthropic gets its 4096 default, OpenAI/Gemini omit the field);
            // system_prompt NULL = no system message prepended at request time.
            sql: "ALTER TABLE conversations ADD COLUMN max_tokens INTEGER NULL;\
                  ALTER TABLE conversations ADD COLUMN system_prompt TEXT NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "fts5 full-text search on messages.content",
            // External-content FTS5 table mirroring messages.content. We key
            // off SQLite's implicit rowid (messages has TEXT PRIMARY KEY 'id'
            // but still gets a rowid). Three triggers keep the index in sync
            // with insert/delete/update on messages — the canonical FTS5
            // external-content idiom. Backfill at the end picks up any rows
            // that already existed before this migration ran.
            //
            // NOTE: every line ends with a SPACE then `\` because Rust
            // string-literal line continuation eats trailing whitespace —
            // without that space we'd get tokens like "BEGININSERT".
            sql: "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5( \
                      content, \
                      content='messages', \
                      content_rowid='rowid', \
                      tokenize='unicode61 remove_diacritics 2' \
                  ); \
                  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN \
                      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); \
                  END; \
                  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN \
                      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); \
                  END; \
                  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN \
                      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); \
                      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); \
                  END; \
                  INSERT INTO messages_fts(messages_fts) VALUES('rebuild');",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "knowledge bases + chunks (local RAG vector store)",
            // Embeddings are stored as a JSON float array in TEXT. We do
            // brute-force cosine on the JS side (fine at local-app scale), so
            // no native vector extension is needed. `dim` lets the UI warn on a
            // model/embedding mismatch. ON DELETE CASCADE keeps chunks tidy.
            sql: "CREATE TABLE IF NOT EXISTS knowledge_bases ( \
                      id          TEXT PRIMARY KEY, \
                      name        TEXT NOT NULL, \
                      provider_id TEXT NULL, \
                      embed_model TEXT NULL, \
                      dim         INTEGER NULL, \
                      created_at  INTEGER NOT NULL \
                  ); \
                  CREATE TABLE IF NOT EXISTS knowledge_chunks ( \
                      id          TEXT PRIMARY KEY, \
                      kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE, \
                      doc_id      TEXT NOT NULL, \
                      source      TEXT NOT NULL, \
                      text        TEXT NOT NULL, \
                      embedding   TEXT NOT NULL, \
                      created_at  INTEGER NOT NULL \
                  ); \
                  CREATE INDEX IF NOT EXISTS idx_chunks_kb ON knowledge_chunks(kb_id); \
                  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);",
            kind: MigrationKind::Up,
        },
    ]
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:taffy-studio.db", migrations())
                .build(),
        );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(Cancellation::default())
        .manage(McpState::default())
        .setup(|app| {
            // Backup BEFORE the SQL plugin gets a chance to run migrations.
            // If a future migration corrupts the schema, the user can revert
            // by copying the latest backup over taffy-studio.db.
            startup_backup(app.handle());
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- Migration upgrade-path test ----------
//
// We don't have the previous-tag-binary swap test the ROADMAP described
// yet (it needs a published v0.1.0 to swap against). What we DO have is
// the data layer's whole migration chain exercised in CI on every PR:
// seed a v1-shape DB, walk the migrations forward, and assert that every
// older row survives + every new column / table is wired correctly.
// Catches "this migration silently drops the temperature column" before
// it hits a user.
#[cfg(test)]
mod migration_tests {
    use super::migrations;
    use rusqlite::{params, Connection};

    /// Apply migrations with `version > *applied < version <= target`, in
    /// order. Stateful: `applied` carries the last-applied version across
    /// repeated calls so the test can step forward — `ALTER TABLE ADD
    /// COLUMN` isn't idempotent and a naive re-run would error out the
    /// second time.
    fn apply_through(conn: &Connection, applied: &mut i64, target: i64) {
        for m in migrations() {
            let v = m.version;
            if v <= *applied {
                continue;
            }
            if v > target {
                break;
            }
            conn.execute_batch(m.sql)
                .unwrap_or_else(|e| panic!("migration v{v} failed: {e}"));
            *applied = v;
        }
        assert!(*applied >= target, "migrations stopped short of v{target}");
    }

    #[test]
    fn upgrade_path_preserves_data() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn = Connection::open(tmp.path()).unwrap();
        // Foreign keys aren't on by default in SQLite. Plugin-sql doesn't
        // enable them either, but turning them on here matches the spirit
        // of the production schema's FK declarations.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let mut applied: i64 = 0;

        // ---- v1: bare conversations + messages ----
        apply_through(&conn, &mut applied, 1);
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)",
            params!["c1", "Original Title", 1000_i64, 1000_i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
            params!["m1", "c1", "user", "hello there world", 1000_i64],
        )
        .unwrap();

        // ---- v2: attachments column added; old rows must have NULL ----
        apply_through(&conn, &mut applied, 2);
        let att: Option<String> = conn
            .query_row(
                "SELECT attachments FROM messages WHERE id = 'm1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(att.is_none(), "old rows must show NULL attachments");

        // New v2-shape insert with an attachments JSON payload.
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) VALUES (?,?,?,?,?,?)",
            params![
                "m2",
                "c1",
                "assistant",
                "got it",
                1100_i64,
                r#"[{"id":"a1","type":"image","name":"x.png","mime":"image/png","size":1,"data":"AA=="}]"#,
            ],
        )
        .unwrap();

        // ---- v3: provider_id + model ----
        apply_through(&conn, &mut applied, 3);
        let (pid, model): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT provider_id, model FROM conversations WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(pid.is_none() && model.is_none());

        // ---- v4: temperature ----
        apply_through(&conn, &mut applied, 4);
        let temp: Option<f64> = conn
            .query_row(
                "SELECT temperature FROM conversations WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(temp.is_none());

        // ---- v5: pinned column with NOT NULL DEFAULT 0 ----
        apply_through(&conn, &mut applied, 5);
        let pinned: i64 = conn
            .query_row(
                "SELECT pinned FROM conversations WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pinned, 0, "existing rows must default to pinned=0");

        // ---- v6: max_tokens + system_prompt ----
        apply_through(&conn, &mut applied, 6);
        let (mt, sp): (Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT max_tokens, system_prompt FROM conversations WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(mt.is_none() && sp.is_none());

        // ---- v7: FTS5 backfill + sync triggers ----
        apply_through(&conn, &mut applied, 7);

        // The v1-inserted message must be findable by the FTS5 backfill.
        let count_hello: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?",
                params!["hello"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_hello, 1, "FTS5 backfill must index pre-v7 rows");

        // Original title untouched all the way through.
        let title: String = conn
            .query_row("SELECT title FROM conversations WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Original Title");

        // INSERT trigger: post-v7 inserts should automatically be indexed.
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
            params!["m3", "c1", "user", "supercalifragilistic", 1200_i64],
        )
        .unwrap();
        let count_new: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?",
                params!["supercalifragilistic"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_new, 1, "ai trigger must index new inserts");

        // DELETE trigger: removing a row should drop it from the index.
        conn.execute("DELETE FROM messages WHERE id = 'm3'", [])
            .unwrap();
        let count_after_del: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?",
                params!["supercalifragilistic"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_after_del, 0, "ad trigger must remove on delete");

        // UPDATE trigger: changing content should re-index.
        conn.execute(
            "UPDATE messages SET content = ? WHERE id = ?",
            params!["zucchini", "m2"],
        )
        .unwrap();
        let count_old_term: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?",
                params!["got"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count_old_term, 0,
            "au trigger must remove old content from index"
        );
        let count_new_term: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?",
                params!["zucchini"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count_new_term, 1,
            "au trigger must add new content to index"
        );

        // ---- v8: knowledge bases + chunks ----
        apply_through(&conn, &mut applied, 8);
        conn.execute(
            "INSERT INTO knowledge_bases (id, name, provider_id, embed_model, dim, created_at) VALUES (?,?,?,?,?,?)",
            params!["kb1", "Docs", "prov1", "text-embedding-3-small", 1536_i64, 1500_i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO knowledge_chunks (id, kb_id, doc_id, source, text, embedding, created_at) VALUES (?,?,?,?,?,?,?)",
            params!["ch1", "kb1", "doc1", "note.md", "hello chunk", "[0.1,0.2,0.3]", 1500_i64],
        )
        .unwrap();
        let chunk_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM knowledge_chunks WHERE kb_id = 'kb1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chunk_count, 1, "v8 chunk insert must round-trip");

        // ON DELETE CASCADE: dropping the KB removes its chunks (FKs are ON in
        // this test connection).
        conn.execute("DELETE FROM knowledge_bases WHERE id = 'kb1'", [])
            .unwrap();
        let orphan_chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM knowledge_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            orphan_chunks, 0,
            "v8 chunks must cascade-delete with the KB"
        );
    }

    /// Independent of the upgrade path: running the WHOLE chain on an empty
    /// DB should also succeed and leave a usable schema. Catches the
    /// degenerate "fresh install" case the upgrade test doesn't cover.
    #[test]
    fn fresh_install_chain_runs_clean() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn = Connection::open(tmp.path()).unwrap();
        for m in migrations() {
            conn.execute_batch(m.sql)
                .unwrap_or_else(|e| panic!("fresh migration v{} failed: {e}", m.version));
        }
        // Sanity: FTS5 virtual table exists and is queryable.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}

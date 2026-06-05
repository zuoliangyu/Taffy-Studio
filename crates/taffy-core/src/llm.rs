//! LLM provider dispatch — transport-agnostic.
//!
//! This module owns the wire format for every supported provider (OpenAI-
//! compatible, Anthropic, Gemini): request building, SSE parsing, and the
//! non-streaming `chat_complete` / `list_models` / `embed_texts` calls.
//!
//! It deliberately knows nothing about Tauri or HTTP servers. The streaming
//! command (`chat_stream`) and the agentic tool-use loop currently live in the
//! Tauri shell and call into the public helpers here; a later milestone will
//! lift the streaming primitive into this crate as a `Stream` so the web shell
//! can reuse it too.

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

// ---------- DTOs (JS <-> Rust) ----------

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
    /// Skill names enabled this turn. When non-empty, the agentic loop adds the
    /// `use_skill` tool plus a progressive-disclosure system block listing them.
    #[serde(default)]
    pub enabled_skills: Vec<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedRequest {
    pub provider: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub input: Vec<String>,
}

// ---------- Provider abstraction ----------

pub fn provider_kind(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" => "gemini",
        _ => "openai", // openai-compatible (openai, deepseek, siliconflow, ollama, ...)
    }
}

pub fn default_base_url(kind: &str) -> &'static str {
    match kind {
        "anthropic" => "https://api.anthropic.com",
        "gemini" => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com/v1",
    }
}

// Build the system text by extracting consecutive leading system messages.
// Anthropic + Gemini require system content out of the messages array.
pub fn split_system(msgs: &[ChatMessage]) -> (String, Vec<&ChatMessage>) {
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
pub enum Sse {
    Data(String),
    Done,
    Other, // event:, id:, comment lines etc.
}

pub fn parse_sse_line(line: &str) -> Sse {
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
pub fn extract_delta(kind: &str, json: &serde_json::Value) -> Option<String> {
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
pub fn is_terminal(kind: &str, json: &serde_json::Value) -> bool {
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

pub fn openai_message(m: &ChatMessage) -> serde_json::Value {
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

pub fn anthropic_message(m: &ChatMessage) -> serde_json::Value {
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

pub fn gemini_message(m: &ChatMessage) -> serde_json::Value {
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

pub fn build_request(
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

// ---------- Pure (non-streaming) calls ----------

/// Fetch the available model list for a provider. Anthropic doesn't expose a
/// model listing endpoint in some accounts, so we fall back to a curated set.
pub async fn list_models(req: &ChatRequest) -> Result<Vec<String>, String> {
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

pub async fn chat_complete(req: &ChatRequest) -> Result<ChatResponse, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let request = build_request(&client, req, false)?;
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    let kind = provider_kind(&req.provider);

    // Some gateways ignore `stream: false` and reply with an SSE body anyway
    // (e.g. proxies that only support streaming). Detect that and reconstruct
    // the full text from the token deltas instead of failing to parse JSON.
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| c.contains("text/event-stream"));
    if is_sse {
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buffer.find('\n') {
                let line: String = buffer.drain(..=nl).collect();
                match parse_sse_line(&line) {
                    Sse::Other => continue,
                    Sse::Done => {
                        return Ok(ChatResponse {
                            content: full,
                            model: req.model.clone(),
                        });
                    }
                    Sse::Data(data) => {
                        let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) else {
                            continue;
                        };
                        if is_terminal(kind, &json) {
                            return Ok(ChatResponse {
                                content: full,
                                model: req.model.clone(),
                            });
                        }
                        // A gateway echoing a non-streamed answer as SSE puts the
                        // whole reply in `message.content` (one frame); a real
                        // stream uses incremental `delta.content`. Accept either.
                        if let Some(c) = extract_delta(kind, &json) {
                            full.push_str(&c);
                        } else if let Some(c) = full_message_content(kind, &json) {
                            full.push_str(&c);
                        }
                    }
                }
            }
        }
        return Ok(ChatResponse {
            content: full,
            model: req.model.clone(),
        });
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    let content = full_message_content(kind, &json).unwrap_or_default();
    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(&req.model)
        .to_string();
    Ok(ChatResponse { content, model })
}

/// Pull the assistant's full reply text out of a *non-streaming* response body
/// (the per-provider shapes). Shared by `chat_complete` and the SSE-fallback
/// path that handles gateways which stream even when `stream: false`.
fn full_message_content(kind: &str, json: &serde_json::Value) -> Option<String> {
    let v = match kind {
        // content is an array: [{type:"text", text:"..."}, ...]
        "anthropic" => json.pointer("/content/0/text"),
        "gemini" => json.pointer("/candidates/0/content/parts/0/text"),
        _ => json.pointer("/choices/0/message/content"),
    };
    v.and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Transport-agnostic streaming completion. Yields `StreamEvent`s as the
/// provider streams tokens; ends with `Done` (or `Error`). This is the plain
/// (non-agentic) path — the Tauri shell still owns the tool-use loop and
/// cancellation registry on top of the same parsing helpers. The axum web
/// shell maps this straight onto SSE.
pub fn chat_stream(req: ChatRequest) -> impl Stream<Item = StreamEvent> {
    async_stream::stream! {
        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(e) => {
                yield StreamEvent::Error { message: e.to_string() };
                return;
            }
        };
        let kind = provider_kind(&req.provider).to_string();
        let request = match build_request(&client, &req, true) {
            Ok(r) => r,
            Err(e) => {
                yield StreamEvent::Error { message: e };
                return;
            }
        };
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                yield StreamEvent::Error { message: e.to_string() };
                return;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            yield StreamEvent::Error { message: format!("HTTP {}: {}", status, text) };
            return;
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    yield StreamEvent::Error { message: format!("stream error: {e}") };
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(nl) = buffer.find('\n') {
                let line: String = buffer.drain(..=nl).collect();
                match parse_sse_line(&line) {
                    Sse::Other => continue,
                    Sse::Done => {
                        yield StreamEvent::Done { content: std::mem::take(&mut full), model: req.model.clone() };
                        return;
                    }
                    Sse::Data(data) => {
                        let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) else {
                            continue;
                        };
                        if is_terminal(&kind, &json) {
                            yield StreamEvent::Done { content: std::mem::take(&mut full), model: req.model.clone() };
                            return;
                        }
                        if let Some(c) = extract_delta(&kind, &json) {
                            if !c.is_empty() {
                                full.push_str(&c);
                                yield StreamEvent::Token { content: c };
                            }
                        }
                    }
                }
            }
        }

        // Stream closed without an explicit terminator.
        yield StreamEvent::Done { content: full, model: req.model.clone() };
    }
}

// ---------- Agentic tool-use loop ----------
//
// When a request carries `tools`, we run a non-streaming round loop instead of
// the token stream: ask the model (with tools), execute any tool calls via the
// MCP layer, feed the results back, and repeat until the model answers without
// calling a tool (or we hit MAX_TOOL_ROUNDS). The final assistant text is
// emitted as Token + Done so the existing UI path renders it; tool activity
// surfaces as ToolCall / ToolResult events.
//
// This is a `Stream<StreamEvent>` like `chat_stream`, so both shells consume it
// identically (Tauri Channel adapter, axum SSE). Cancellation is the consumer's
// job: stop polling / drop the stream and the in-flight HTTP + the loop stop.

/// Max agentic tool-use rounds before we force a final answer. Guards against a
/// model that keeps calling tools forever.
const MAX_TOOL_ROUNDS: usize = 8;

/// Cap a tool result before surfacing it to the UI (the full text still goes
/// back to the model). Keeps a runaway tool from flooding the event stream.
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

/// The built-in skills tool, and the sentinel server id we tag it with so the
/// UI / dispatch can tell it apart from MCP tools.
const USE_SKILL: &str = "use_skill";
const BUILTIN_SERVER: &str = "__builtin__";

/// Skills available to `use_skill` this turn (loaded once per agentic run).
struct SkillCtx {
    store: std::sync::Arc<crate::skills::SkillStore>,
    metas: Vec<crate::skills::SkillMeta>,
}

fn build_skill_ctx(
    store: &std::sync::Arc<crate::skills::SkillStore>,
    enabled: &[String],
) -> Option<SkillCtx> {
    if enabled.is_empty() {
        return None;
    }
    let metas: Vec<_> = store
        .list()
        .into_iter()
        .filter(|m| enabled.iter().any(|n| n == &m.name))
        .collect();
    if metas.is_empty() {
        None
    } else {
        Some(SkillCtx {
            store: store.clone(),
            metas,
        })
    }
}

/// Progressive-disclosure system block: only name + description go into context;
/// the full SKILL.md loads on demand when the model calls `use_skill`.
fn available_skills_prompt(metas: &[crate::skills::SkillMeta]) -> String {
    let mut s = String::from(
        "**Skills**\nYou have access to the following skills. Use the `use_skill` \
         tool to load a skill's instructions when the user's request matches one.\n\
         <available_skills>\n",
    );
    for m in metas {
        s.push_str("  <skill>\n");
        s.push_str(&format!("    <name>{}</name>\n", m.name));
        s.push_str(&format!(
            "    <description>{}</description>\n",
            m.description
        ));
        s.push_str("  </skill>\n");
    }
    s.push_str("</available_skills>");
    s
}

fn use_skill_spec() -> ToolSpec {
    ToolSpec {
        server_id: BUILTIN_SERVER.to_string(),
        name: USE_SKILL.to_string(),
        description: "Load and apply a skill to get specialized instructions or \
             capabilities. Call this tool when the user's request matches one of the \
             available skills."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "The name of the skill to use" },
                "path": {
                    "type": "string",
                    "description": "Optional relative path to a file inside the skill directory. Omit to read the default SKILL.md instructions. Only use paths from Markdown links in the SKILL.md content; do not guess paths."
                }
            },
            "required": ["name"]
        }),
    }
}

/// Run `use_skill`: read the skill's SKILL.md body (or a referenced file). Never
/// executes anything — just returns text to inject as the tool result.
fn exec_use_skill(ctx: Option<&SkillCtx>, args: &serde_json::Value) -> String {
    let Some(ctx) = ctx else {
        return "ERROR: skills are not available".to_string();
    };
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() {
        return "ERROR: use_skill requires a 'name'".to_string();
    }
    if !ctx.metas.iter().any(|m| m.name == name) {
        let avail: Vec<&str> = ctx.metas.iter().map(|m| m.name.as_str()).collect();
        return format!(
            "ERROR: skill '{name}' is not enabled. Available: {}",
            avail.join(", ")
        );
    }
    match args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        None => ctx
            .store
            .read_body(name)
            .unwrap_or_else(|| format!("ERROR: skill '{name}' has no SKILL.md")),
        Some(p) => ctx
            .store
            .read_file(name, p)
            .unwrap_or_else(|e| format!("ERROR: {e}")),
    }
}

async fn exec_tool(
    tools: &[ToolSpec],
    mcp: &crate::mcp::McpState,
    skills: Option<&SkillCtx>,
    name: &str,
    args: serde_json::Value,
) -> String {
    if name == USE_SKILL {
        return exec_use_skill(skills, &args);
    }
    match tool_server_for(tools, name) {
        Some(t) => crate::mcp::call_tool(mcp, &t.server_id, name, args)
            .await
            .unwrap_or_else(|e| format!("ERROR: {e}")),
        None => format!("ERROR: tool '{name}' is not connected"),
    }
}

/// Read the round's response into the JSON shape the agentic loop parses.
///
/// The loop asks for `stream: false`, so a conformant provider returns a JSON
/// body we parse directly. But some gateways ignore that and stream an SSE body
/// anyway (deltas, including tool-call fragments). When that happens we
/// accumulate the SSE frames back into the same non-streaming shape
/// (`{choices:[{message}]}` for OpenAI, `{content, stop_reason}` for Anthropic),
/// so the rest of the loop is unchanged. Maps transport/HTTP/parse failures to a
/// single error string the caller yields as `StreamEvent::Error`.
async fn read_json(
    resp: Result<reqwest::Response, String>,
    kind: &str,
) -> Result<serde_json::Value, String> {
    let resp = resp?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| c.contains("text/event-stream"));
    if is_sse {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        return Ok(if kind == "anthropic" {
            accumulate_anthropic_sse(&text)
        } else {
            accumulate_openai_sse(&text)
        });
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Rebuild an OpenAI non-streaming `{choices:[{message}]}` from an SSE body.
/// Handles both true deltas (`choices[0].delta`, tool-call fragments keyed by
/// `index`) and a full message echoed in one frame (`choices[0].message`).
fn accumulate_openai_sse(text: &str) -> serde_json::Value {
    let mut content = String::new();
    let mut has_content = false;
    // (id, name, arguments) per tool-call index.
    let mut tcs: Vec<(String, String, String)> = Vec::new();
    let mut finish: Option<String> = None;
    let mut full_message: Option<serde_json::Value> = None;

    for data in sse_data_frames(text) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some(choice) = v.pointer("/choices/0") else {
            continue;
        };
        if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) {
            finish = Some(fr.to_string());
        }
        if let Some(msg) = choice.get("message") {
            full_message = Some(msg.clone()); // a non-streamed message in one frame
            continue;
        }
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
            content.push_str(c);
            has_content = true;
        }
        if let Some(arr) = delta.get("tool_calls").and_then(|x| x.as_array()) {
            for tc in arr {
                let idx = tc.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                while tcs.len() <= idx {
                    tcs.push((String::new(), String::new(), String::new()));
                }
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        tcs[idx].0 = id.to_string();
                    }
                }
                if let Some(n) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                    if !n.is_empty() {
                        tcs[idx].1 = n.to_string();
                    }
                }
                if let Some(a) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                    tcs[idx].2.push_str(a);
                }
            }
        }
    }

    if let Some(msg) = full_message {
        return serde_json::json!({ "choices": [{ "message": msg, "finish_reason": finish }] });
    }
    let tool_calls: Vec<serde_json::Value> = tcs
        .into_iter()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, args)| {
            serde_json::json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": if args.is_empty() { "{}".into() } else { args } },
            })
        })
        .collect();
    let mut message = serde_json::json!({ "role": "assistant" });
    message["content"] = if has_content {
        serde_json::Value::String(content)
    } else {
        serde_json::Value::Null
    };
    if !tool_calls.is_empty() {
        message["tool_calls"] = serde_json::Value::Array(tool_calls);
    }
    serde_json::json!({ "choices": [{ "message": message, "finish_reason": finish }] })
}

/// Rebuild an Anthropic non-streaming `{content:[...], stop_reason}` from an SSE
/// body of `content_block_*` / `message_delta` events.
fn accumulate_anthropic_sse(text: &str) -> serde_json::Value {
    // (kind, text, id, name, partial_json) per content-block index.
    let mut blocks: Vec<(String, String, String, String, String)> = Vec::new();
    let mut stop_reason: Option<String> = None;

    for data in sse_data_frames(text) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block_start") => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                while blocks.len() <= idx {
                    blocks.push((
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                }
                let cb = v.get("content_block");
                let kind = cb
                    .and_then(|c| c.get("type"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("text");
                blocks[idx].0 = kind.to_string();
                if let Some(id) = cb.and_then(|c| c.get("id")).and_then(|x| x.as_str()) {
                    blocks[idx].2 = id.to_string();
                }
                if let Some(n) = cb.and_then(|c| c.get("name")).and_then(|x| x.as_str()) {
                    blocks[idx].3 = n.to_string();
                }
            }
            Some("content_block_delta") => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                if idx >= blocks.len() {
                    continue;
                }
                let delta = v.get("delta");
                if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|x| x.as_str()) {
                    blocks[idx].1.push_str(t);
                }
                if let Some(p) = delta
                    .and_then(|d| d.get("partial_json"))
                    .and_then(|x| x.as_str())
                {
                    blocks[idx].4.push_str(p);
                }
            }
            Some("message_delta") => {
                if let Some(sr) = v.pointer("/delta/stop_reason").and_then(|x| x.as_str()) {
                    stop_reason = Some(sr.to_string());
                }
            }
            _ => {}
        }
    }

    let content: Vec<serde_json::Value> = blocks
        .into_iter()
        .map(|(kind, text, id, name, partial)| {
            if kind == "tool_use" {
                let input = serde_json::from_str::<serde_json::Value>(&partial)
                    .unwrap_or_else(|_| serde_json::json!({}));
                serde_json::json!({ "type": "tool_use", "id": id, "name": name, "input": input })
            } else {
                serde_json::json!({ "type": "text", "text": text })
            }
        })
        .collect();
    serde_json::json!({ "content": content, "stop_reason": stop_reason })
}

/// Iterate the `data:` payloads of an SSE body (skipping blanks / `[DONE]`).
fn sse_data_frames(text: &str) -> impl Iterator<Item = String> + '_ {
    text.lines().filter_map(|line| {
        let line = line.trim_end_matches('\r');
        let data = line.strip_prefix("data:")?.trim();
        if data.is_empty() || data == "[DONE]" {
            None
        } else {
            Some(data.to_string())
        }
    })
}

/// Agentic counterpart to `chat_stream`: drives the MCP tool-use loop and yields
/// the same `StreamEvent`s. `mcp` is the shared registry of connected servers.
pub fn agentic_stream(
    req: ChatRequest,
    tools: Vec<ToolSpec>,
    mcp: std::sync::Arc<crate::mcp::McpState>,
    skills: std::sync::Arc<crate::skills::SkillStore>,
) -> impl Stream<Item = StreamEvent> {
    async_stream::stream! {
        let mut req = req;
        let mut tools = tools;

        // Skills: if any are enabled this turn, surface them as the `use_skill`
        // tool + a progressive-disclosure system block. They compose with MCP
        // tools — the model loads a skill's instructions, then acts using tools.
        let skill_ctx = build_skill_ctx(&skills, &req.enabled_skills);
        if let Some(ctx) = &skill_ctx {
            req.messages.insert(
                0,
                ChatMessage {
                    role: "system".to_string(),
                    content: available_skills_prompt(&ctx.metas),
                    attachments: Vec::new(),
                },
            );
            tools.push(use_skill_spec());
        }

        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(e) => {
                yield StreamEvent::Error { message: e.to_string() };
                return;
            }
        };
        let kind = provider_kind(&req.provider).to_string();
        let base = req
            .base_url
            .clone()
            .unwrap_or_else(|| default_base_url(&kind).to_string());
        let base = base.trim_end_matches('/').to_string();
        let key = req.api_key.as_deref().unwrap_or("");

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
                let parsed_key = match key.parse() {
                    Ok(v) => v,
                    Err(e) => {
                        let e: reqwest::header::InvalidHeaderValue = e;
                        yield StreamEvent::Error { message: e.to_string() };
                        return;
                    }
                };
                h.insert("x-api-key", parsed_key);
                h.insert("anthropic-version", "2023-06-01".parse().unwrap());
                h.insert("content-type", "application/json".parse().unwrap());

                let resp = client
                    .post(format!("{base}/v1/messages"))
                    .headers(h)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| e.to_string());
                let json = match read_json(resp, &kind).await {
                    Ok(j) => j,
                    Err(e) => {
                        yield StreamEvent::Error { message: e };
                        return;
                    }
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
                                    yield StreamEvent::Token { content: t.into() };
                                }
                            }
                        }
                        Some("tool_use") => tool_uses.push(b.clone()),
                        _ => {}
                    }
                }

                if stop != "tool_use" || tool_uses.is_empty() {
                    yield StreamEvent::Done {
                        content: std::mem::take(&mut full),
                        model: req.model.clone(),
                    };
                    return;
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
                    yield StreamEvent::ToolCall {
                        id: id.clone(),
                        server_id: tool_server_for(&tools, &name)
                            .map(|t| t.server_id.clone())
                            .unwrap_or_default(),
                        name: name.clone(),
                        args: input.to_string(),
                    };
                    let out = exec_tool(&tools, &mcp, skill_ctx.as_ref(), &name, input).await;
                    yield StreamEvent::ToolResult {
                        id: id.clone(),
                        name: name.clone(),
                        result: truncate_for_ui(&out),
                    };
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
                    let parsed_key = match format!("Bearer {key}").parse() {
                        Ok(v) => v,
                        Err(e) => {
                            let e: reqwest::header::InvalidHeaderValue = e;
                            yield StreamEvent::Error { message: e.to_string() };
                            return;
                        }
                    };
                    h.insert("authorization", parsed_key);
                }
                h.insert("content-type", "application/json".parse().unwrap());

                let resp = client
                    .post(format!("{base}/chat/completions"))
                    .headers(h)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| e.to_string());
                let json = match read_json(resp, &kind).await {
                    Ok(j) => j,
                    Err(e) => {
                        yield StreamEvent::Error { message: e };
                        return;
                    }
                };

                let msg = json
                    .pointer("/choices/0/message")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if !content.is_empty() {
                    full.push_str(content);
                    yield StreamEvent::Token { content: content.into() };
                }

                let tool_calls = msg
                    .get("tool_calls")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                if tool_calls.is_empty() {
                    yield StreamEvent::Done {
                        content: std::mem::take(&mut full),
                        model: req.model.clone(),
                    };
                    return;
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
                    yield StreamEvent::ToolCall {
                        id: id.clone(),
                        server_id: tool_server_for(&tools, &name)
                            .map(|t| t.server_id.clone())
                            .unwrap_or_default(),
                        name: name.clone(),
                        args: args_str.clone(),
                    };
                    let args_val: serde_json::Value =
                        serde_json::from_str(&args_str).unwrap_or(serde_json::json!({}));
                    let out = exec_tool(&tools, &mcp, skill_ctx.as_ref(), &name, args_val).await;
                    yield StreamEvent::ToolResult {
                        id: id.clone(),
                        name: name.clone(),
                        result: truncate_for_ui(&out),
                    };
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": id,
                        "content": out,
                    }));
                }
            }
        }

        // Ran out of rounds — emit whatever we have so the user isn't left hanging.
        yield StreamEvent::Done {
            content: std::mem::take(&mut full),
            model: req.model.clone(),
        };
    }
}

pub async fn embed_texts(req: &EmbedRequest) -> Result<Vec<Vec<f32>>, String> {
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

#[cfg(test)]
mod agentic_sse_tests {
    use super::*;

    #[test]
    fn openai_sse_accumulates_tool_call_deltas() {
        // tool_call streamed across frames: name in the first, args in pieces.
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get-sum\",\"arguments\":\"\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\\\":1\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\",\\\"b\\\":2}\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: [DONE]\n",
        );
        let v = accumulate_openai_sse(sse);
        let tc = &v["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(tc["id"], serde_json::json!("call_1"));
        assert_eq!(tc["function"]["name"], serde_json::json!("get-sum"));
        assert_eq!(
            tc["function"]["arguments"],
            serde_json::json!("{\"a\":1,\"b\":2}")
        );
    }

    #[test]
    fn openai_sse_accumulates_content() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"po\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ng\"}}]}\n",
            "data: [DONE]\n",
        );
        let v = accumulate_openai_sse(sse);
        assert_eq!(
            v["choices"][0]["message"]["content"],
            serde_json::json!("pong")
        );
        assert!(v["choices"][0]["message"]["tool_calls"].is_null());
    }

    #[test]
    fn openai_sse_full_message_frame() {
        // some gateways echo a whole non-streamed message in one frame
        let sse =
            "data: {\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"hi\"}}]}\n";
        let v = accumulate_openai_sse(sse);
        assert_eq!(
            v["choices"][0]["message"]["content"],
            serde_json::json!("hi")
        );
    }

    #[test]
    fn anthropic_sse_accumulates_tool_use() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"get-sum\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\\\":1,\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"b\\\":2}\"}}\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n",
        );
        let v = accumulate_anthropic_sse(sse);
        assert_eq!(v["stop_reason"], serde_json::json!("tool_use"));
        let b = &v["content"][0];
        assert_eq!(b["type"], serde_json::json!("tool_use"));
        assert_eq!(b["name"], serde_json::json!("get-sum"));
        assert_eq!(b["input"]["a"], serde_json::json!(1));
        assert_eq!(b["input"]["b"], serde_json::json!(2));
    }
}

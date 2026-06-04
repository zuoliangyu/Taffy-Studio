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

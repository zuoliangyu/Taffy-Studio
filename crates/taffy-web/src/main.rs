// taffy-web — axum HTTP shell over taffy-core. Serves the embedded React SPA
// and exposes the same operations as the Tauri shell over HTTP (+ SSE for
// streaming), all delegating to taffy-core. Build the frontend first
// (`vite build` → dist/) so rust-embed has something to embed.
mod static_files;

use axum::{
    extract::{Extension, Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        Response, Sse,
    },
    routing::{delete, get, post},
    Json, Router,
};
use clap::Parser;
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use taffy_core::mcp::{McpServerConfig, McpState, McpTool};
use taffy_core::{ChatRequest, ChatResponse, Conversation, EmbedRequest, Message, StreamEvent};
use tower_http::cors::CorsLayer;

type Shared = Arc<taffy_core::Db>;
/// Shared MCP registry, threaded to handlers via `Extension` (the `State` slot
/// is taken by the DB). One registry per server process, like the desktop shell.
type Mcp = Arc<McpState>;

#[derive(Parser, Debug, Clone)]
#[command(name = "taffy-web", about = "Taffy Studio — self-hosted web server")]
struct Config {
    /// Address to bind. Use 0.0.0.0 in containers.
    #[arg(long, default_value = "127.0.0.1", env = "TAFFY_HOST")]
    host: String,

    /// Port to listen on.
    #[arg(long, default_value_t = 8787, env = "TAFFY_PORT")]
    port: u16,

    /// SQLite database file. Defaults to the location the desktop app uses, so
    /// both shells share one config + history
    /// (config_dir/com.taffy.studio/taffy-studio.db). In a container, point
    /// this at a mounted volume (the entrypoint passes /data/taffy.db).
    #[arg(long, env = "TAFFY_DB_PATH")]
    db_path: Option<String>,

    /// Bearer token gating the API (single-user). No auth if unset.
    #[arg(long, env = "TAFFY_TOKEN")]
    token: Option<String>,

    /// Don't auto-open the browser on startup (headless servers / containers).
    #[arg(long, env = "TAFFY_NO_OPEN")]
    no_open: bool,
}

/// Best-effort: open the default browser at `url`. Errors are ignored (headless
/// boxes have no browser, which is fine).
fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

#[derive(Clone)]
struct AppToken(Option<String>);

fn ise<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
}

/// Auth middleware. With a token configured, every API request must carry
/// `Authorization: Bearer <token>`; without one (dev), all requests pass.
async fn check_auth(request: Request, next: Next) -> Result<Response, StatusCode> {
    let expected = request
        .extensions()
        .get::<AppToken>()
        .cloned()
        .unwrap_or(AppToken(None));
    if let Some(tok) = expected.0.as_deref() {
        if bearer_token(request.headers()) != Some(tok) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(request).await)
}

/// Resolve the provider API key. The browser never holds keys on the web shell;
/// the server injects them from the environment (per-kind, then a generic
/// fallback) when the request doesn't already carry one.
fn key_for(provider: &str, current: &Option<String>) -> Option<String> {
    if let Some(k) = current {
        if !k.is_empty() {
            return Some(k.clone());
        }
    }
    let per_kind = match taffy_core::llm::provider_kind(provider) {
        "anthropic" => "TAFFY_ANTHROPIC_API_KEY",
        "gemini" => "TAFFY_GEMINI_API_KEY",
        _ => "TAFFY_OPENAI_API_KEY",
    };
    std::env::var(per_kind)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("TAFFY_API_KEY").ok().filter(|s| !s.is_empty()))
}

// ---------- LLM / embed ----------

async fn health_handler() -> &'static str {
    "ok"
}

async fn models_handler(
    Json(mut req): Json<ChatRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::list_models(&req).await.map(Json).map_err(ise)
}

async fn chat_complete_handler(
    Json(mut req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::chat_complete(&req).await.map(Json).map_err(ise)
}

async fn chat_stream_handler(
    Extension(mcp): Extension<Mcp>,
    Json(mut req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, axum::Error>>> {
    req.api_key = key_for(&req.provider, &req.api_key);
    // Agentic path when tools are attached on a tool-capable provider; otherwise
    // a plain token stream. Both are core `Stream`s — box to one type. The
    // browser cancels by aborting the fetch, which drops this stream server-side.
    let kind = taffy_core::llm::provider_kind(&req.provider);
    let use_tools = matches!(kind, "openai" | "anthropic")
        && req.tools.as_ref().is_some_and(|t| !t.is_empty());
    let events: std::pin::Pin<Box<dyn Stream<Item = StreamEvent> + Send>> = if use_tools {
        let tools = req.tools.clone().unwrap_or_default();
        Box::pin(taffy_core::llm::agentic_stream(req, tools, mcp))
    } else {
        Box::pin(taffy_core::llm::chat_stream(req))
    };
    let stream = events.map(|ev| Event::default().json_data(&ev));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn embed_handler(
    Json(mut req): Json<EmbedRequest>,
) -> Result<Json<Vec<Vec<f32>>>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::embed_texts(&req).await.map(Json).map_err(ise)
}

// ---------- MCP ----------
//
// The server hosts the MCP stdio connections (a browser can't spawn processes).
// NOTE: the spawned commands must exist in the server's environment — in a
// container the base image needs node/npx etc. for the usual `npx ...` servers.

#[derive(Deserialize)]
struct McpDisconnectBody {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpCallBody {
    server_id: String,
    name: String,
    #[serde(default)]
    args: serde_json::Value,
}

async fn mcp_connect_h(
    Extension(mcp): Extension<Mcp>,
    Json(cfg): Json<McpServerConfig>,
) -> Result<Json<Vec<McpTool>>, (StatusCode, String)> {
    taffy_core::mcp::connect(&mcp, cfg).await.map(Json).map_err(ise)
}

async fn mcp_disconnect_h(
    Extension(mcp): Extension<Mcp>,
    Json(b): Json<McpDisconnectBody>,
) -> Result<(), (StatusCode, String)> {
    taffy_core::mcp::disconnect(&mcp, &b.id).await;
    Ok(())
}

async fn mcp_tools_h(Extension(mcp): Extension<Mcp>) -> Json<Vec<McpTool>> {
    Json(taffy_core::mcp::all_tools(&mcp).await)
}

async fn mcp_call_h(
    Extension(mcp): Extension<Mcp>,
    Json(b): Json<McpCallBody>,
) -> Result<Json<String>, (StatusCode, String)> {
    taffy_core::mcp::call_tool(&mcp, &b.server_id, &b.name, b.args)
        .await
        .map(Json)
        .map_err(ise)
}

// ---------- conversations ----------

#[derive(Deserialize)]
struct CreateConv {
    title: String,
    #[serde(default)]
    init: Option<taffy_core::db::ConversationInit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelBody {
    provider_id: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct TemperatureBody {
    temperature: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaxTokensBody {
    max_tokens: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemPromptBody {
    system_prompt: Option<String>,
}

#[derive(Deserialize)]
struct TitleBody {
    title: String,
}

#[derive(Deserialize)]
struct PinnedBody {
    pinned: bool,
}

async fn conv_list_h(
    State(db): State<Shared>,
) -> Result<Json<Vec<Conversation>>, (StatusCode, String)> {
    db.list_conversations().map(Json).map_err(ise)
}

async fn conv_create_h(
    State(db): State<Shared>,
    Json(b): Json<CreateConv>,
) -> Result<Json<Conversation>, (StatusCode, String)> {
    db.create_conversation(&b.title, &b.init.unwrap_or_default())
        .map(Json)
        .map_err(ise)
}

async fn conv_model_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<ModelBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_model(&id, b.provider_id.as_deref(), b.model.as_deref())
        .map_err(ise)
}

async fn conv_temperature_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<TemperatureBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_temperature(&id, b.temperature).map_err(ise)
}

async fn conv_max_tokens_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<MaxTokensBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_max_tokens(&id, b.max_tokens).map_err(ise)
}

async fn conv_system_prompt_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<SystemPromptBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_system_prompt(&id, b.system_prompt.as_deref())
        .map_err(ise)
}

async fn conv_title_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<TitleBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_title(&id, &b.title).map_err(ise)
}

async fn conv_pinned_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<PinnedBody>,
) -> Result<(), (StatusCode, String)> {
    db.update_conversation_pinned(&id, b.pinned).map_err(ise)
}

async fn conv_delete_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
) -> Result<(), (StatusCode, String)> {
    db.delete_conversation(&id).map_err(ise)
}

// ---------- messages ----------

#[derive(Deserialize)]
struct AppendMsg {
    role: String,
    content: String,
    #[serde(default)]
    attachments: Option<serde_json::Value>,
}

async fn msg_list_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Message>>, (StatusCode, String)> {
    db.list_messages(&id).map(Json).map_err(ise)
}

async fn msg_append_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<AppendMsg>,
) -> Result<Json<Message>, (StatusCode, String)> {
    db.append_message(&id, &b.role, &b.content, b.attachments)
        .map(Json)
        .map_err(ise)
}

async fn msg_delete_h(
    State(db): State<Shared>,
    Path(id): Path<String>,
) -> Result<(), (StatusCode, String)> {
    db.delete_message(&id).map_err(ise)
}

// ---------- KV ----------

async fn kv_get_h(
    State(db): State<Shared>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match db.kv_get(&key) {
        Ok(Some(v)) => Ok(Json(v)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn kv_set_h(
    State(db): State<Shared>,
    Path(key): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Result<(), (StatusCode, String)> {
    db.kv_set(&key, &value).map_err(ise)
}

async fn kv_delete_h(
    State(db): State<Shared>,
    Path(key): Path<String>,
) -> Result<(), (StatusCode, String)> {
    db.kv_delete(&key).map_err(ise)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::parse();

    // Default to the shared desktop+web database location.
    let db_path = config
        .db_path
        .clone()
        .unwrap_or_else(taffy_core::default_db_path);
    let db: Shared = Arc::new(taffy_core::Db::open(&db_path).expect("failed to open database"));
    // One MCP registry for the process, shared with handlers via Extension.
    let mcp: Mcp = Arc::new(McpState::default());

    let api = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/models", post(models_handler))
        .route("/api/chat/complete", post(chat_complete_handler))
        .route("/api/chat/stream", post(chat_stream_handler))
        .route("/api/embed", post(embed_handler))
        .route("/api/mcp/connect", post(mcp_connect_h))
        .route("/api/mcp/disconnect", post(mcp_disconnect_h))
        .route("/api/mcp/tools", get(mcp_tools_h))
        .route("/api/mcp/call", post(mcp_call_h))
        .route("/api/conversations", get(conv_list_h).post(conv_create_h))
        .route("/api/conversations/{id}", delete(conv_delete_h))
        .route("/api/conversations/{id}/model", post(conv_model_h))
        .route("/api/conversations/{id}/temperature", post(conv_temperature_h))
        .route("/api/conversations/{id}/max_tokens", post(conv_max_tokens_h))
        .route("/api/conversations/{id}/system_prompt", post(conv_system_prompt_h))
        .route("/api/conversations/{id}/title", post(conv_title_h))
        .route("/api/conversations/{id}/pinned", post(conv_pinned_h))
        .route(
            "/api/conversations/{id}/messages",
            get(msg_list_h).post(msg_append_h),
        )
        .route("/api/messages/{id}", delete(msg_delete_h))
        .route(
            "/api/kv/{key}",
            get(kv_get_h).put(kv_set_h).delete(kv_delete_h),
        )
        .layer(middleware::from_fn(check_auth))
        .with_state(db);

    let static_routes = Router::new().fallback(static_files::static_handler);

    let app = Router::new()
        .merge(api)
        .merge(static_routes)
        .layer(CorsLayer::permissive())
        .layer(axum::Extension(mcp))
        .layer(axum::Extension(AppToken(config.token.clone())));

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");

    tracing::info!("Taffy Studio web server on http://{addr}  (db: {db_path})");
    if config.token.is_some() {
        tracing::info!("Auth enabled (Bearer token required)");
    } else {
        tracing::warn!("No auth — set --token / TAFFY_TOKEN to require a Bearer token");
    }

    if !config.no_open {
        let port = config.port;
        tokio::spawn(async move {
            // Give the server a beat to start accepting before we point a
            // browser at it.
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            open_browser(&format!("http://localhost:{port}"));
        });
    }

    axum::serve(listener, app).await.expect("server error");
}

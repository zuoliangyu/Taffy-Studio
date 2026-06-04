// taffy-web — axum HTTP shell over taffy-core. Serves the embedded SPA and the
// LLM/embed surface (semantic endpoints, SSE streaming). Conversation/message
// endpoints arrive with the data-layer move (milestone M3b).
mod static_files;

use axum::{
    extract::Request,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use futures_util::{Stream, StreamExt};
use taffy_core::{ChatRequest, ChatResponse, EmbedRequest};
use tower_http::cors::CorsLayer;

#[derive(Parser, Debug, Clone)]
#[command(name = "taffy-web", about = "Taffy Studio — self-hosted web server")]
struct Config {
    /// Address to bind. Use 0.0.0.0 in containers.
    #[arg(long, default_value = "127.0.0.1", env = "TAFFY_HOST")]
    host: String,

    /// Port to listen on.
    #[arg(long, default_value_t = 8787, env = "TAFFY_PORT")]
    port: u16,

    /// Bearer token gating the API (single-user). No auth if unset.
    #[arg(long, env = "TAFFY_TOKEN")]
    token: Option<String>,
}

/// Expected bearer token, shared via request extension.
#[derive(Clone)]
struct AppToken(Option<String>);

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
}

/// Auth middleware. When a token is configured, every API request must carry
/// `Authorization: Bearer <token>`. When unset (dev), all requests pass.
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

async fn health_handler() -> &'static str {
    "ok"
}

async fn models_handler(
    Json(mut req): Json<ChatRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::list_models(&req)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn chat_complete_handler(
    Json(mut req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::chat_complete(&req)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn chat_stream_handler(
    Json(mut req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, axum::Error>>> {
    req.api_key = key_for(&req.provider, &req.api_key);
    let stream = taffy_core::llm::chat_stream(req).map(|ev| Event::default().json_data(&ev));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn embed_handler(
    Json(mut req): Json<EmbedRequest>,
) -> Result<Json<Vec<Vec<f32>>>, (StatusCode, String)> {
    req.api_key = key_for(&req.provider, &req.api_key);
    taffy_core::llm::embed_texts(&req)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::parse();

    let api = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/models", post(models_handler))
        .route("/api/chat/complete", post(chat_complete_handler))
        .route("/api/chat/stream", post(chat_stream_handler))
        .route("/api/embed", post(embed_handler))
        .layer(middleware::from_fn(check_auth));

    let static_routes = Router::new().fallback(static_files::static_handler);

    let app = Router::new()
        .merge(api)
        .merge(static_routes)
        .layer(CorsLayer::permissive())
        .layer(axum::Extension(AppToken(config.token.clone())));

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");

    tracing::info!("Taffy Studio web server on http://{addr}");
    if config.token.is_some() {
        tracing::info!("Auth enabled (Bearer token required)");
    } else {
        tracing::warn!("No auth — set --token / TAFFY_TOKEN to require a Bearer token");
    }

    axum::serve(listener, app).await.expect("server error");
}

// Serve the React frontend, embedded into the binary at compile time. Build it
// first (`vite build` → `dist/`) or this folder won't exist. Falls back to
// index.html so client-side routing works.
use axum::http::{header, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../dist"]
struct Asset;

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if !path.is_empty() {
        if let Some(content) = Asset::get(path) {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data.into_owned(),
            )
                .into_response();
        }
    }

    // SPA fallback.
    match Asset::get("index.html") {
        Some(content) => Html(String::from_utf8_lossy(&content.data).to_string()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "Frontend not built. Run `vite build` (or `npm run build`) first.",
        )
            .into_response(),
    }
}

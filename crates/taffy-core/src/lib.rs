//! taffy-core — platform-agnostic business logic for Taffy Studio.
//!
//! Every shell (Tauri desktop/mobile today, axum web server later) depends on
//! this crate so the LLM/embedding logic is written exactly once. Nothing here
//! references `tauri::` or `axum::`.

pub mod db;
pub mod llm;

// Convenience re-exports so shells can `use taffy_core::ChatRequest` etc.
pub use db::{Conversation, ConversationInit, Db, Message};
pub use llm::{
    Attachment, ChatMessage, ChatRequest, ChatResponse, EmbedRequest, StreamEvent, ToolSpec,
};

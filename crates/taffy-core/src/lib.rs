//! taffy-core — platform-agnostic business logic for Taffy Studio.
//!
//! Every shell (Tauri desktop/mobile today, axum web server later) depends on
//! this crate so the LLM/embedding logic is written exactly once. Nothing here
//! references `tauri::` or `axum::`.

pub mod db;
pub mod llm;
pub mod mcp;
pub mod skills;

// Convenience re-exports so shells can `use taffy_core::ChatRequest` etc.
pub use db::{
    default_db_path, ChunkInput, Conversation, ConversationInit, Db, DocSummary, ExportedConversation,
    ImportSummary, KnowledgeBase, Message, RetrievedChunk, SearchHit,
};
pub use llm::{
    Attachment, ChatMessage, ChatRequest, ChatResponse, EmbedRequest, StreamEvent, ToolSpec,
};
pub use mcp::{McpServerConfig, McpState, McpTool};
pub use skills::{default_skills_root, SkillMeta, SkillStore};

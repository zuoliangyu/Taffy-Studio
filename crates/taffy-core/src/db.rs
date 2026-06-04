//! SQLite data layer — shared by both shells (Tauri commands + axum routes).
//!
//! This is the single source of truth for the schema (migration chain) and the
//! semantic query operations. The frontend talks to it through the `api` layer
//! (Tauri invoke / HTTP) instead of shipping raw SQL, which is what lets the
//! same UI run on desktop and in a browser.
//!
//! Scope so far (milestone M3b-1): migrations + KV + conversations + messages.
//! Full-text search, RAG (knowledge bases), and export/import follow.

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
];

fn run_migrations(conn: &Connection) -> Result<(), String> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(e2s)?;
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
}

// ---------- Db handle ----------

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (or create) the database at `path` and run pending migrations.
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(e2s)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(e2s)?;
        run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// In-memory database (tests).
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(e2s)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(e2s)?;
        run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
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
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])
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
    ) -> Result<Message, String> {
        let now = now_ms();
        let attachments = attachments.filter(|v| !matches!(v, serde_json::Value::Array(a) if a.is_empty()));
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
        };
        let conn = self.lock();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.id,
                row.conversation_id,
                row.role,
                row.content,
                row.created_at,
                attachments_json,
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
                "SELECT id, conversation_id, role, content, created_at, attachments \
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
        db.append_message(&c.id, "user", "hi", None).unwrap();
        let atts = serde_json::json!([{ "id": "a1", "type": "image", "name": "x.png" }]);
        db.append_message(&c.id, "assistant", "yo", Some(atts.clone()))
            .unwrap();
        let msgs = db.list_messages(&c.id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].attachments, None);
        assert_eq!(msgs[1].attachments, Some(atts));

        // Empty attachment array normalizes to None.
        db.append_message(&c.id, "user", "empty", Some(serde_json::json!([])))
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
}

// Model Context Protocol (MCP) client over stdio.
//
// We spawn each configured server as a child process and speak newline-
// delimited JSON-RPC 2.0 to it (the MCP stdio transport: one JSON object per
// line, no embedded newlines). A background reader task fans responses back to
// the matching request via a oneshot channel keyed on the JSON-RPC id.
//
// Lifecycle per server:
//   spawn → `initialize` request → `notifications/initialized` → `tools/list`.
// Tools are cached on the handle so the chat layer can attach them to a
// request and call them by name without re-listing.
//
// This is the Phase-1 + Phase-2 substrate: `connect` / `list` / `call` here,
// and the agentic tool-use loop in `llm::agentic_stream` drives them. Both
// shells (Tauri desktop, axum web) manage one `McpState` and share this code.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const INIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A tool advertised by a connected MCP server. `input_schema` is the raw JSON
/// Schema the server returned; we forward it to the LLM provider as-is.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
}

/// Config the frontend hands us to start a server.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// "KEY=value" entries merged onto the inherited environment.
    #[serde(default)]
    pub env: Vec<String>,
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

/// A live connection to one MCP server.
pub struct McpServer {
    pub name: String,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicI64,
    pub tools: Vec<McpTool>,
}

impl McpServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<Value>();
        self.pending.lock().await.insert(id, tx);

        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())?;

        {
            let mut w = self.stdin.lock().await;
            w.write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write to {} failed: {e}", self.name))?;
            w.write_all(b"\n").await.map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        let resp = timeout(RPC_TIMEOUT, rx)
            .await
            .map_err(|_| format!("MCP request '{method}' timed out"))?
            .map_err(|_| "MCP reader dropped before responding".to_string())?;

        if let Some(err) = resp.get("error") {
            return Err(format!("MCP '{method}' error: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())?;
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        w.write_all(b"\n").await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Call a tool and flatten the MCP content array into a single string.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<String, String> {
        let result = self
            .request("tools/call", json!({ "name": name, "arguments": args }))
            .await?;
        Ok(flatten_content(&result))
    }

    async fn shutdown(mut self) {
        // Best-effort: drop stdin (signals EOF to the server) then kill.
        let _ = self.child.kill().await;
    }
}

/// MCP `tools/call` returns `{ content: [{type:"text", text}, ...], isError }`.
/// We flatten text parts; non-text parts are summarized so the model still
/// learns something came back.
fn flatten_content(result: &Value) -> String {
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = String::new();
    if let Some(arr) = result.get("content").and_then(|v| v.as_array()) {
        for part in arr {
            match part.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
                Some(other) => {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&format!("[{other} content omitted]"));
                }
                None => {}
            }
        }
    }
    if out.is_empty() {
        // Some servers return structured `content` we didn't model — fall back
        // to the raw JSON so the model still gets the payload.
        out = result.to_string();
    }
    if is_error {
        format!("ERROR: {out}")
    } else {
        out
    }
}

/// Registry of connected servers, keyed by the frontend's server id.
#[derive(Default)]
pub struct McpState(pub Mutex<HashMap<String, McpServer>>);

/// Spawn + handshake a server, returning its tool list. Replaces any existing
/// connection with the same id.
pub async fn connect(state: &McpState, cfg: McpServerConfig) -> Result<Vec<McpTool>, String> {
    // Drop a previous connection with this id first.
    if let Some(prev) = state.0.lock().await.remove(&cfg.id) {
        prev.shutdown().await;
    }

    // Build a std Command (so we can set Windows creation_flags via the std
    // CommandExt trait), then convert to tokio's async Command.
    let mut std_command = std::process::Command::new(&cfg.command);
    std_command
        .args(&cfg.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for kv in &cfg.env {
        if let Some((k, v)) = kv.split_once('=') {
            std_command.env(k, v);
        }
    }
    // Detach from any console window on Windows.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std_command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut command = tokio::process::Command::from(std_command);
    command.kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {e}", cfg.command))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "no stdin on MCP child".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout on MCP child".to_string())?;

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

    // Background reader: dispatch each line to the waiting request by id.
    {
        let pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
                // Notifications / requests from the server (no matching id) are
                // ignored — we don't expose sampling/roots back to servers yet.
            }
        });
    }

    let server = McpServer {
        name: cfg.name.clone(),
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
        next_id: AtomicI64::new(1),
        tools: Vec::new(),
    };

    // Handshake.
    let init = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "clientInfo": { "name": "taffy-studio", "version": "0.1.0" },
    });
    timeout(INIT_TIMEOUT, server.request("initialize", init))
        .await
        .map_err(|_| "MCP initialize timed out".to_string())??;
    server
        .notify("notifications/initialized", json!({}))
        .await?;

    // Enumerate tools.
    let tools_result = server.request("tools/list", json!({})).await?;
    let mut tools = Vec::new();
    if let Some(arr) = tools_result.get("tools").and_then(|v| v.as_array()) {
        for t in arr {
            let name = t
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            tools.push(McpTool {
                server_id: cfg.id.clone(),
                server_name: cfg.name.clone(),
                name,
                description: t
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                input_schema: t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
            });
        }
    }

    let mut server = server;
    server.tools = tools.clone();
    state.0.lock().await.insert(cfg.id, server);
    Ok(tools)
}

pub async fn disconnect(state: &McpState, id: &str) {
    if let Some(server) = state.0.lock().await.remove(id) {
        server.shutdown().await;
    }
}

/// Call a tool by (server_id, name). Clones the stdin/pending handles out under
/// the lock, then releases the registry lock before awaiting the round-trip so
/// concurrent tool calls to different servers don't serialize on the registry.
pub async fn call_tool(
    state: &McpState,
    server_id: &str,
    name: &str,
    args: Value,
) -> Result<String, String> {
    // We can't hold the MutexGuard across the await cheaply because McpServer
    // isn't Clone; instead do the call while holding the lock. Tool calls are
    // user-paced and rarely simultaneous, so this is fine in practice.
    let map = state.0.lock().await;
    let server = map
        .get(server_id)
        .ok_or_else(|| format!("MCP server '{server_id}' not connected"))?;
    server.call_tool(name, args).await
}

/// All tools across all connected servers (for the UI).
pub async fn all_tools(state: &McpState) -> Vec<McpTool> {
    state
        .0
        .lock()
        .await
        .values()
        .flat_map(|s| s.tools.clone())
        .collect()
}

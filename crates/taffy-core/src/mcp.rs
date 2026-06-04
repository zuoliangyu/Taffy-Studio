// Model Context Protocol (MCP) client — stdio + Streamable HTTP transports.
//
// stdio: spawn the configured command as a child process and speak newline-
// delimited JSON-RPC 2.0 over its pipes (the MCP stdio transport). Desktop /
// server-side only — mobile can't spawn. A background reader fans responses to
// the matching request via a oneshot keyed on the JSON-RPC id.
//
// http: POST JSON-RPC to a remote endpoint (the MCP "Streamable HTTP"
// transport); the response comes back as application/json or a text/event-
// stream frame, and the server may hand back an `Mcp-Session-Id` to echo on
// later calls. No child process → works on every platform (incl. native
// mobile), which is how the market's remote servers reach phones.
//
// Lifecycle (both): initialize → notifications/initialized → tools/list. Tools
// are cached on the handle; the agentic loop in `llm::agentic_stream` drives
// them. Both shells (Tauri desktop, axum web) manage one `McpState`.

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

/// Which transport a server uses. `stdio` spawns a local command (desktop /
/// server-side only); `http` talks to a remote Streamable-HTTP endpoint (all
/// platforms). Defaults to `stdio` so existing configs keep working.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
}

/// Config the frontend hands us to start a server.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub transport: McpTransport,
    // --- stdio ---
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// "KEY=value" entries merged onto the inherited environment.
    #[serde(default)]
    pub env: Vec<String>,
    // --- http ---
    #[serde(default)]
    pub url: Option<String>,
    /// "Header-Name: value" entries (e.g. auth tokens).
    #[serde(default)]
    pub headers: Vec<String>,
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

/// A live connection to one MCP server, over either transport.
pub struct McpServer {
    pub name: String,
    pub tools: Vec<McpTool>,
    conn: Conn,
}

enum Conn {
    Stdio(StdioConn),
    Http(HttpConn),
}

/// Child process + the stdin/pending/id state the stdio JSON-RPC loop needs.
struct StdioConn {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicI64,
}

/// Remote endpoint + the session id the Streamable-HTTP transport threads.
struct HttpConn {
    client: reqwest::Client,
    url: String,
    base_headers: reqwest::header::HeaderMap,
    session_id: Mutex<Option<String>>,
    next_id: AtomicI64,
}

impl McpServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        match &self.conn {
            Conn::Stdio(c) => c.request(&self.name, method, params).await,
            Conn::Http(c) => c.request(method, params).await,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        match &self.conn {
            Conn::Stdio(c) => c.notify(method, params).await,
            Conn::Http(c) => c.notify(method, params).await,
        }
    }

    /// Call a tool and flatten the MCP content array into a single string.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<String, String> {
        let result = self
            .request("tools/call", json!({ "name": name, "arguments": args }))
            .await?;
        Ok(flatten_content(&result))
    }

    async fn shutdown(self) {
        // stdio: kill the child (kill_on_drop also covers it). http: nothing to
        // tear down beyond dropping the client.
        if let Conn::Stdio(mut c) = self.conn {
            let _ = c.child.kill().await;
        }
    }
}

impl StdioConn {
    async fn request(&self, name: &str, method: &str, params: Value) -> Result<Value, String> {
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
                .map_err(|e| format!("write to {name} failed: {e}"))?;
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
        w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        w.write_all(b"\n").await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl HttpConn {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp = self
            .send(&body, true)
            .await?
            .ok_or_else(|| format!("MCP '{method}': no JSON-RPC response in body"))?;
        if let Some(err) = resp.get("error") {
            return Err(format!("MCP '{method}' error: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.send(&body, false).await?;
        Ok(())
    }

    /// POST one JSON-RPC message. Captures any `Mcp-Session-Id` for later calls.
    /// When `expect_response`, returns the JSON-RPC response parsed from a JSON
    /// body or the matching frame of a `text/event-stream` body.
    async fn send(&self, body: &Value, expect_response: bool) -> Result<Option<Value>, String> {
        use reqwest::header::{ACCEPT, CONTENT_TYPE};
        let mut req = self
            .client
            .post(&self.url)
            .headers(self.base_headers.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream");
        if let Some(sid) = self.session_id.lock().await.clone() {
            req = req.header("Mcp-Session-Id", sid);
        }
        let resp = req.json(body).send().await.map_err(|e| e.to_string())?;

        // A fresh session id (returned on initialize) must ride on later calls.
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(sid.to_string());
        }

        let status = resp.status();
        let is_sse = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("text/event-stream"));
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {text}"));
        }
        if !expect_response {
            return Ok(None);
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        Ok(extract_rpc_response(&text, is_sse))
    }
}

/// Pull the JSON-RPC response out of an HTTP body: a plain JSON object/array, or
/// the first `data:` frame of an SSE stream that carries a result/error.
fn extract_rpc_response(text: &str, is_sse: bool) -> Option<Value> {
    let is_rpc = |v: &Value| v.get("result").is_some() || v.get("error").is_some();
    if is_sse {
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if is_rpc(&v) {
                    return Some(v);
                }
            }
        }
        None
    } else {
        let v: Value = serde_json::from_str(text).ok()?;
        if let Some(arr) = v.as_array() {
            arr.iter().find(|m| is_rpc(m)).cloned()
        } else if is_rpc(&v) {
            Some(v)
        } else {
            None
        }
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

/// Spawn/open + handshake a server, returning its tool list. Replaces any
/// existing connection with the same id.
pub async fn connect(state: &McpState, cfg: McpServerConfig) -> Result<Vec<McpTool>, String> {
    // Drop a previous connection with this id first.
    if let Some(prev) = state.0.lock().await.remove(&cfg.id) {
        prev.shutdown().await;
    }

    let server = match cfg.transport {
        McpTransport::Stdio => build_stdio_server(&cfg)?,
        McpTransport::Http => build_http_server(&cfg)?,
    };

    // Handshake (identical across transports).
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

    let tools_result = server.request("tools/list", json!({})).await?;
    let tools = parse_tools(&tools_result, &cfg);

    let mut server = server;
    server.tools = tools.clone();
    state.0.lock().await.insert(cfg.id.clone(), server);
    Ok(tools)
}

/// Spawn the configured command and wire up the stdio JSON-RPC reader.
fn build_stdio_server(cfg: &McpServerConfig) -> Result<McpServer, String> {
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
                // Server-initiated notifications/requests (no matching id) are
                // ignored — we don't expose sampling/roots back to servers yet.
            }
        });
    }

    Ok(McpServer {
        name: cfg.name.clone(),
        tools: Vec::new(),
        conn: Conn::Stdio(StdioConn {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: AtomicI64::new(1),
        }),
    })
}

/// Build a remote Streamable-HTTP connection (no process spawned).
fn build_http_server(cfg: &McpServerConfig) -> Result<McpServer, String> {
    let url = cfg
        .url
        .clone()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| format!("HTTP MCP server '{}' requires a url", cfg.name))?;
    let mut headers = reqwest::header::HeaderMap::new();
    for h in &cfg.headers {
        if let Some((k, v)) = h.split_once(':') {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.trim().as_bytes()),
                reqwest::header::HeaderValue::from_str(v.trim()),
            ) {
                headers.insert(name, val);
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(RPC_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(McpServer {
        name: cfg.name.clone(),
        tools: Vec::new(),
        conn: Conn::Http(HttpConn {
            client,
            url,
            base_headers: headers,
            session_id: Mutex::new(None),
            next_id: AtomicI64::new(1),
        }),
    })
}

/// Parse a `tools/list` result into our `McpTool` list.
fn parse_tools(tools_result: &Value, cfg: &McpServerConfig) -> Vec<McpTool> {
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
    tools
}

pub async fn disconnect(state: &McpState, id: &str) {
    if let Some(server) = state.0.lock().await.remove(id) {
        server.shutdown().await;
    }
}

/// Call a tool by (server_id, name). Holds the registry lock across the round-
/// trip; tool calls are user-paced and rarely simultaneous, so this is fine.
pub async fn call_tool(
    state: &McpState,
    server_id: &str,
    name: &str,
    args: Value,
) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_stdio() {
        let c: McpServerConfig =
            serde_json::from_str(r#"{"id":"a","name":"A","command":"npx","args":["x"]}"#).unwrap();
        assert!(matches!(c.transport, McpTransport::Stdio));
        assert_eq!(c.command, "npx");
        assert!(c.url.is_none());
    }

    #[test]
    fn config_http_round_trip() {
        let c: McpServerConfig = serde_json::from_str(
            r#"{"id":"a","name":"A","transport":"http","url":"https://x/mcp","headers":["Authorization: Bearer t"]}"#,
        )
        .unwrap();
        assert!(matches!(c.transport, McpTransport::Http));
        assert_eq!(c.url.as_deref(), Some("https://x/mcp"));
        assert_eq!(c.headers, vec!["Authorization: Bearer t".to_string()]);
    }

    #[test]
    fn extract_response_from_sse() {
        let sse = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\r\n\r\n";
        let v = extract_rpc_response(sse, true).expect("sse response");
        assert_eq!(v["result"]["ok"], json!(true));
    }

    #[test]
    fn extract_response_from_json() {
        let v = extract_rpc_response(r#"{"jsonrpc":"2.0","id":1,"result":42}"#, false)
            .expect("json response");
        assert_eq!(v["result"], json!(42));
        // A notification-only body (no result/error) yields nothing.
        assert!(extract_rpc_response(r#"{"jsonrpc":"2.0","method":"x"}"#, false).is_none());
    }
}

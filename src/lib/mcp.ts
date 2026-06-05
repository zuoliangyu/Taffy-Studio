// MCP client — frontend half. Server *configs* are persisted in the Store; the
// live *connections* live in Rust (see crates/taffy-core/src/mcp.rs). This
// module wraps the invoke() surface and the config persistence.
import { api } from '../services/api'
import { getSetting, setSetting } from './store'

/** Transport for an MCP server. `stdio` spawns a local command (desktop /
 *  server-side only — mobile can't spawn); `http` talks to a remote
 *  Streamable-HTTP endpoint (works on every platform). Omitted = stdio. */
export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  /** Stable uuid. */
  id: string
  name: string
  /** Defaults to 'stdio' when omitted (back-compat with existing configs). */
  transport?: McpTransport
  // --- stdio ---
  command: string
  args: string[]
  /** "KEY=value" entries. */
  env: string[]
  // --- http ---
  /** Remote endpoint (required when transport is 'http'). */
  url?: string
  /** "Header-Name: value" entries, e.g. auth tokens. */
  headers?: string[]
  /** Auto-connect on app start. */
  enabled?: boolean
}

export interface McpTool {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: unknown
}

/** Tool shape sent on a ChatRequest (matches Rust ToolSpec). */
export interface ToolSpec {
  serverId: string
  name: string
  description: string
  inputSchema: unknown
}

const STORE_KEY = 'mcpServers'

export async function loadMcpServers(): Promise<McpServerConfig[]> {
  const v = await getSetting<McpServerConfig[]>(STORE_KEY)
  return Array.isArray(v) ? v : []
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await setSetting(STORE_KEY, servers)
}

/** Spawn + handshake a server, returning its tool list. */
export function mcpConnect(config: McpServerConfig): Promise<McpTool[]> {
  return api.mcpConnect(config)
}

export function mcpDisconnect(id: string): Promise<void> {
  return api.mcpDisconnect(id)
}

/** All tools across all currently-connected servers. */
export function mcpListTools(): Promise<McpTool[]> {
  return api.mcpListTools()
}

export function mcpCallTool(
  serverId: string,
  name: string,
  args: unknown,
): Promise<string> {
  return api.mcpCallTool(serverId, name, args)
}

/** Result of unpacking a user-authored stdio MCP zip (a `taffy-mcp.json`
 *  manifest + code). `command`/`args` already have their `${dir}` tokens
 *  resolved to the managed install directory, so they're ready to spawn. */
export interface McpImportResult {
  name: string
  command: string
  args: string[]
  env: string[]
}

/** Import a self-authored stdio MCP server from a zip (desktop / server-side).
 *  Returns the manifest-derived spawn config; the caller wraps it into an
 *  `McpServerConfig` and persists it. */
export function mcpImportZip(bytes: ArrayBuffer): Promise<McpImportResult> {
  return api.mcpImportZip(bytes)
}

/** Convert connected tools into the ToolSpec[] a ChatRequest carries. */
export function toolsToSpecs(tools: McpTool[]): ToolSpec[] {
  return tools.map((t) => ({
    serverId: t.serverId,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

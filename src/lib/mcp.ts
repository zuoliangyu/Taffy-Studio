// MCP client — frontend half. Server *configs* are persisted in the Store; the
// live *connections* live in Rust (see src-tauri/src/mcp.rs). This module wraps
// the invoke() surface and the config persistence.
import { invoke } from '@tauri-apps/api/core'
import { getSetting, setSetting } from './store'

export interface McpServerConfig {
  /** Stable uuid. */
  id: string
  name: string
  command: string
  args: string[]
  /** "KEY=value" entries. */
  env: string[]
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
  return invoke<McpTool[]>('mcp_connect', { config })
}

export function mcpDisconnect(id: string): Promise<void> {
  return invoke<void>('mcp_disconnect', { id })
}

/** All tools across all currently-connected servers. */
export function mcpListTools(): Promise<McpTool[]> {
  return invoke<McpTool[]>('mcp_list_tools')
}

export function mcpCallTool(
  serverId: string,
  name: string,
  args: unknown,
): Promise<string> {
  return invoke<string>('mcp_call_tool', { serverId, name, args })
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

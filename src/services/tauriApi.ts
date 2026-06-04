// Tauri backend driver — every Rust call from the renderer goes through here
// when the app runs as a Tauri shell (desktop/mobile). The web shell provides
// a matching `webApi.ts` (fetch/SSE); `api.ts` picks one at compile time via
// `__IS_TAURI__`. Keeping the two modules signature-identical is what lets the
// React components stay 100% transport-agnostic.
import { Channel, invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'
import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  StreamHandle,
} from '../lib/llm'
import type { McpServerConfig, McpTool } from '../lib/mcp'
import type { BackupInfo, StorageInfo } from '../lib/storage'

/** Embedding request shape (mirrors Rust `EmbedRequest`). */
export interface EmbedRequest {
  provider: string
  baseUrl?: string
  apiKey?: string
  model: string
  input: string[]
}

// ---------- misc ----------

export function getPlatform(): Promise<string> {
  // platform() is sync in @tauri-apps/plugin-os v2; wrap for a uniform shape.
  return Promise.resolve(platform())
}

export function ping(payload: string): Promise<string> {
  return invoke<string>('ping', { payload })
}

// ---------- filesystem (consented absolute paths from plugin-dialog) ----------

export function fsWriteTextAbs(path: string, contents: string): Promise<void> {
  return invoke<void>('fs_write_text_abs', { path, contents })
}

export function fsReadTextAbs(path: string): Promise<string> {
  return invoke<string>('fs_read_text_abs', { path })
}

// ---------- secrets (OS keyring) ----------

export function secretSupported(): Promise<boolean> {
  return invoke<boolean>('secret_supported')
}

export function secretGet(key: string): Promise<string | null> {
  return invoke<string | null>('secret_get', { key })
}

export function secretSet(key: string, value: string): Promise<void> {
  return invoke<void>('secret_set', { key, value })
}

export function secretDelete(key: string): Promise<void> {
  return invoke<void>('secret_delete', { key })
}

// ---------- LLM ----------

export function listModels(req: ChatRequest): Promise<string[]> {
  return invoke<string[]>('list_models', { req })
}

export function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  return invoke<ChatResponse>('chat_complete', { req })
}

export function chatStream(
  req: ChatRequest,
  onEvent: (e: StreamEvent) => void,
): StreamHandle {
  const id = req.streamId ?? crypto.randomUUID()
  const ch = new Channel<StreamEvent>()
  ch.onmessage = onEvent
  const promise = invoke<void>('chat_stream', {
    req: { ...req, streamId: id },
    onEvent: ch,
  })
  return {
    id,
    promise,
    cancel: () => invoke<boolean>('cancel_stream', { id }).then(() => void 0),
  }
}

export function cancelStream(id: string): Promise<void> {
  return invoke<boolean>('cancel_stream', { id }).then(() => void 0)
}

export function embedTexts(req: EmbedRequest): Promise<number[][]> {
  return invoke<number[][]>('embed_texts', { req })
}

// ---------- MCP ----------

export function mcpConnect(config: McpServerConfig): Promise<McpTool[]> {
  return invoke<McpTool[]>('mcp_connect', { config })
}

export function mcpDisconnect(id: string): Promise<void> {
  return invoke<void>('mcp_disconnect', { id })
}

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

// ---------- storage / backups ----------

export function storageInfo(): Promise<StorageInfo> {
  return invoke<StorageInfo>('storage_info')
}

export function backupNow(): Promise<BackupInfo> {
  return invoke<BackupInfo>('backup_now')
}

export function resetDatabase(): Promise<void> {
  return invoke<void>('reset_database')
}

export function openConfigDir(): Promise<void> {
  return invoke<void>('open_config_dir')
}

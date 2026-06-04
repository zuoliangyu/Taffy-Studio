// Web backend driver — the HTTP/SSE counterpart to `tauriApi.ts`, used when the
// app is served by the (future) `taffy-web` axum shell and opened in a browser.
//
// STATUS: stubs. The signatures here mirror `tauriApi.ts` exactly so the React
// components type-check against either shell; the real `fetch('/api/...')` +
// EventSource implementations land with the web shell (milestone M3). Until
// then every call throws so a misconfigured build fails loudly instead of
// silently no-op-ing.
import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  StreamHandle,
} from '../lib/llm'
import type { McpServerConfig, McpTool } from '../lib/mcp'
import type { BackupInfo, StorageInfo } from '../lib/storage'
import type { DbExecResult, EmbedRequest } from './tauriApi'

function notImpl(name: string): never {
  throw new Error(`[web] ${name} is not implemented yet (web shell pending — milestone M3)`)
}

// ---------- misc ----------

export function getPlatform(): Promise<string> {
  return Promise.resolve('web')
}

export function ping(_payload: string): Promise<string> {
  return notImpl('ping')
}

// ---------- filesystem ----------

export function fsWriteTextAbs(_path: string, _contents: string): Promise<void> {
  return notImpl('fsWriteTextAbs')
}

export function fsReadTextAbs(_path: string): Promise<string> {
  return notImpl('fsReadTextAbs')
}

// ---------- secrets ----------

export function secretSupported(): Promise<boolean> {
  // No OS keyring in a browser; the server holds secrets. Report unsupported so
  // settings.ts uses its server-side fallback path once that's wired.
  return Promise.resolve(false)
}

export function secretGet(_key: string): Promise<string | null> {
  return notImpl('secretGet')
}

export function secretSet(_key: string, _value: string): Promise<void> {
  return notImpl('secretSet')
}

export function secretDelete(_key: string): Promise<void> {
  return notImpl('secretDelete')
}

// ---------- LLM ----------

export function listModels(_req: ChatRequest): Promise<string[]> {
  return notImpl('listModels')
}

export function chatComplete(_req: ChatRequest): Promise<ChatResponse> {
  return notImpl('chatComplete')
}

export function chatStream(
  _req: ChatRequest,
  _onEvent: (e: StreamEvent) => void,
): StreamHandle {
  const err = new Error('[web] chatStream is not implemented yet (milestone M3)')
  return { id: '', promise: Promise.reject(err), cancel: () => Promise.resolve() }
}

export function cancelStream(_id: string): Promise<void> {
  return Promise.resolve()
}

export function embedTexts(_req: EmbedRequest): Promise<number[][]> {
  return notImpl('embedTexts')
}

// ---------- MCP ----------

export function mcpConnect(_config: McpServerConfig): Promise<McpTool[]> {
  return notImpl('mcpConnect')
}

export function mcpDisconnect(_id: string): Promise<void> {
  return notImpl('mcpDisconnect')
}

export function mcpListTools(): Promise<McpTool[]> {
  return notImpl('mcpListTools')
}

export function mcpCallTool(
  _serverId: string,
  _name: string,
  _args: unknown,
): Promise<string> {
  return notImpl('mcpCallTool')
}

// ---------- storage / backups ----------

export function storageInfo(): Promise<StorageInfo> {
  return notImpl('storageInfo')
}

export function backupNow(): Promise<BackupInfo> {
  return notImpl('backupNow')
}

export function resetDatabase(): Promise<void> {
  return notImpl('resetDatabase')
}

export function openConfigDir(): Promise<void> {
  return notImpl('openConfigDir')
}

// ---------- SQLite ----------

export function dbInit(): Promise<void> {
  return notImpl('dbInit')
}

export function dbSelect<T>(_sql: string, _params?: unknown[]): Promise<T> {
  return notImpl('dbSelect')
}

export function dbExecute(_sql: string, _params?: unknown[]): Promise<DbExecResult> {
  return notImpl('dbExecute')
}

// ---------- KV store ----------

export function kvGet<T>(_key: string): Promise<T | null> {
  return notImpl('kvGet')
}

export function kvSet<T>(_key: string, _value: T): Promise<void> {
  return notImpl('kvSet')
}

export function kvDelete(_key: string): Promise<void> {
  return notImpl('kvDelete')
}

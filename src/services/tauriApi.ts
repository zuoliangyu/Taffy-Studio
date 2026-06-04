// Tauri backend driver — every Rust call from the renderer goes through here
// when the app runs as a Tauri shell (desktop/mobile). The web shell provides
// a matching `webApi.ts` (fetch/SSE); `api.ts` picks one at compile time via
// `__IS_TAURI__`. Keeping the two modules signature-identical is what lets the
// React components stay 100% transport-agnostic.
import { Channel, invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'
import Database from '@tauri-apps/plugin-sql'
import { Store } from '@tauri-apps/plugin-store'
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

// ---------- SQLite (tauri-plugin-sql) ----------

/** Result of a write; mirrors tauri-plugin-sql's QueryResult. */
export interface DbExecResult {
  rowsAffected: number
  lastInsertId?: number
}

let _db: Database | null = null
async function db(): Promise<Database> {
  if (_db) return _db
  // URL is resolved relative to the AppConfig dir on every platform.
  // Migrations run in Rust on plugin init.
  _db = await Database.load('sqlite:taffy-studio.db')
  return _db
}

/** Open the DB (and trigger Rust-side migrations) without issuing a query. */
export async function dbInit(): Promise<void> {
  await db()
}

export async function dbSelect<T>(sql: string, params?: unknown[]): Promise<T> {
  return (await db()).select<T>(sql, params)
}

export async function dbExecute(sql: string, params?: unknown[]): Promise<DbExecResult> {
  return (await db()).execute(sql, params)
}

// ---------- KV store (tauri-plugin-store, settings.json) ----------

let _store: Store | null = null
async function store(): Promise<Store> {
  if (_store) return _store
  // `defaults` is required by StoreOptions; each setting carries its own
  // default at the call site, so an empty map is fine.
  _store = await Store.load('settings.json', { autoSave: true, defaults: {} })
  return _store
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const v = await (await store()).get<T>(key)
  return v ?? null
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await (await store()).set(key, value)
}

export async function kvDelete(key: string): Promise<void> {
  await (await store()).delete(key)
}

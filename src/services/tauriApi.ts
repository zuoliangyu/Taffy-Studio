// Tauri backend driver — every Rust call from the renderer goes through here
// when the app runs as a Tauri shell (desktop/mobile). The web shell provides
// a matching `webApi.ts` (fetch/SSE); `api.ts` picks one at compile time via
// `__IS_TAURI__`. Keeping the two modules signature-identical is what lets the
// React components stay 100% transport-agnostic.
import { Channel, invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'
import type {
  Conversation,
  ConversationInit,
  ExportedConversation,
  ImportConversation,
  ImportSummary,
  Message,
  MessageAttachment,
  SearchHitRaw,
} from '../lib/db'
import type {
  ChatRequest,
  ChatResponse,
  StreamEvent,
  StreamHandle,
} from '../lib/llm'
import type { McpServerConfig, McpTool } from '../lib/mcp'
import type {
  ChunkInput,
  DocSummary,
  KnowledgeBase,
  KnowledgeBasePatch,
  RetrievedChunk,
} from '../lib/rag'
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

// ---------- RAG (knowledge bases) ----------

export function ragListKbs(): Promise<KnowledgeBase[]> {
  return invoke<KnowledgeBase[]>('rag_list_kbs')
}

export function ragCreateKb(
  name: string,
  providerId: string | null,
  embedModel: string | null,
): Promise<KnowledgeBase> {
  return invoke<KnowledgeBase>('rag_create_kb', { name, providerId, embedModel })
}

export function ragUpdateKb(id: string, patch: KnowledgeBasePatch): Promise<void> {
  return invoke<void>('rag_update_kb', { id, patch })
}

export function ragDeleteKb(id: string): Promise<void> {
  return invoke<void>('rag_delete_kb', { id })
}

export function ragListDocs(kbId: string): Promise<DocSummary[]> {
  return invoke<DocSummary[]>('rag_list_docs', { kbId })
}

export function ragCountChunks(kbId: string): Promise<number> {
  return invoke<number>('rag_count_chunks', { kbId })
}

export function ragDeleteDoc(docId: string): Promise<void> {
  return invoke<void>('rag_delete_doc', { docId })
}

export function ragAddChunks(
  kbId: string,
  docId: string,
  source: string,
  items: ChunkInput[],
): Promise<number> {
  return invoke<number>('rag_add_chunks', { kbId, docId, source, items })
}

export function ragSearch(
  kbId: string,
  embedding: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  return invoke<RetrievedChunk[]>('rag_search', { kbId, embedding, topK })
}

// ---------- full-text search + JSON export/import ----------

export function searchMessages(query: string, limit: number): Promise<SearchHitRaw[]> {
  return invoke<SearchHitRaw[]>('search_messages', { query, limit })
}

export function exportConversations(): Promise<ExportedConversation[]> {
  return invoke<ExportedConversation[]>('export_conversations')
}

export function importConversations(
  conversations: ImportConversation[],
): Promise<ImportSummary> {
  return invoke<ImportSummary>('import_conversations', { conversations })
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

// ---------- SQLite — semantic ops (taffy-core::db via Tauri commands) ----------

/** No-op: the DB is opened + migrated in Rust at app startup. */
export function dbInit(): Promise<void> {
  return invoke<void>('db_init')
}

export function listConversations(): Promise<Conversation[]> {
  return invoke<Conversation[]>('conv_list')
}

export function createConversation(
  title: string,
  init?: ConversationInit,
): Promise<Conversation> {
  return invoke<Conversation>('conv_create', { title, init })
}

export function updateConversationModel(
  id: string,
  providerId: string | null,
  model: string | null,
): Promise<void> {
  return invoke<void>('conv_update_model', { id, providerId, model })
}

export function updateConversationTemperature(
  id: string,
  temperature: number | null,
): Promise<void> {
  return invoke<void>('conv_update_temperature', { id, temperature })
}

export function updateConversationMaxTokens(
  id: string,
  maxTokens: number | null,
): Promise<void> {
  return invoke<void>('conv_update_max_tokens', { id, maxTokens })
}

export function updateConversationSystemPrompt(
  id: string,
  systemPrompt: string | null,
): Promise<void> {
  return invoke<void>('conv_update_system_prompt', { id, systemPrompt })
}

export function updateConversationTitle(id: string, title: string): Promise<void> {
  return invoke<void>('conv_update_title', { id, title })
}

export function updateConversationPinned(id: string, pinned: boolean): Promise<void> {
  return invoke<void>('conv_update_pinned', { id, pinned })
}

export function deleteConversation(id: string): Promise<void> {
  return invoke<void>('conv_delete', { id })
}

export function appendMessage(
  conversationId: string,
  role: Message['role'],
  content: string,
  attachments?: MessageAttachment[],
): Promise<Message> {
  return invoke<Message>('msg_append', { conversationId, role, content, attachments })
}

export function listMessages(conversationId: string): Promise<Message[]> {
  return invoke<Message[]>('msg_list', { conversationId })
}

export function deleteMessage(id: string): Promise<void> {
  return invoke<void>('msg_delete', { id })
}

// ---------- KV store (taffy-core::db `kv` table) ----------

export function kvGet<T>(key: string): Promise<T | null> {
  return invoke<T | null>('kv_get', { key })
}

export function kvSet<T>(key: string, value: T): Promise<void> {
  return invoke<void>('kv_set', { key, value })
}

export function kvDelete(key: string): Promise<void> {
  return invoke<void>('kv_delete', { key })
}

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
import type {
  Conversation,
  ConversationInit,
  Message,
  MessageAttachment,
} from '../lib/db'
import type { McpServerConfig, McpTool } from '../lib/mcp'
import type {
  ChunkInput,
  DocSummary,
  KnowledgeBase,
  KnowledgeBasePatch,
  RetrievedChunk,
} from '../lib/rag'
import type { BackupInfo, StorageInfo } from '../lib/storage'
import type { DbExecResult, EmbedRequest } from './tauriApi'

function notImpl(name: string): never {
  throw new Error(`[web] ${name} is not implemented yet (data layer pending — milestone M3b)`)
}

// Single-user bearer token, if the server requires one. Stored in localStorage
// (a proper login UI comes later). Sent on every request.
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  const tok =
    typeof localStorage !== 'undefined' ? localStorage.getItem('taffy_token') : null
  if (tok) h.authorization = `Bearer ${tok}`
  return h
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json() as Promise<T>
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders() })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json() as Promise<T>
}

async function send(path: string, method: string, body?: unknown): Promise<void> {
  const r = await fetch(path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`)
}

// ---------- misc ----------

export function getPlatform(): Promise<string> {
  return Promise.resolve('web')
}

export async function ping(payload: string): Promise<string> {
  const r = await fetch('/api/health', { headers: authHeaders() })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return `${(await r.text()).trim()}: ${payload}`
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

export function listModels(req: ChatRequest): Promise<string[]> {
  return postJson<string[]>('/api/models', req)
}

export function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  return postJson<ChatResponse>('/api/chat/complete', req)
}

export function chatStream(
  req: ChatRequest,
  onEvent: (e: StreamEvent) => void,
): StreamHandle {
  const id = req.streamId ?? crypto.randomUUID()
  const ctrl = new AbortController()
  const promise = (async () => {
    let res: Response
    try {
      res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...req, streamId: id }),
        signal: ctrl.signal,
      })
    } catch (e) {
      if (!ctrl.signal.aborted) onEvent({ type: 'error', message: String(e) })
      return
    }
    if (!res.ok || !res.body) {
      onEvent({ type: 'error', message: `HTTP ${res.status}` })
      return
    }
    // Parse the SSE byte stream: frames are `data: <json>` lines.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            onEvent(JSON.parse(data) as StreamEvent)
          } catch {
            /* skip malformed frame */
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) onEvent({ type: 'error', message: String(e) })
    }
  })()
  return {
    id,
    promise,
    cancel: () => {
      ctrl.abort()
      return Promise.resolve()
    },
  }
}

export function cancelStream(_id: string): Promise<void> {
  // The web stream is cancelled by aborting its fetch (see the handle above);
  // there's no separate server endpoint to hit.
  return Promise.resolve()
}

export function embedTexts(req: EmbedRequest): Promise<number[][]> {
  return postJson<number[][]>('/api/embed', req)
}

// ---------- MCP ----------

// MCP stdio subprocesses run on the *server* (a browser can't spawn them); the
// taffy-web shell hosts the connections and exposes them over /api/mcp. The
// spawned commands must exist in the server's environment (e.g. node/npx in a
// container image), otherwise connect() fails like any bad command.
export function mcpConnect(config: McpServerConfig): Promise<McpTool[]> {
  return postJson<McpTool[]>('/api/mcp/connect', config)
}

export function mcpDisconnect(id: string): Promise<void> {
  return send('/api/mcp/disconnect', 'POST', { id })
}

export function mcpListTools(): Promise<McpTool[]> {
  return getJson<McpTool[]>('/api/mcp/tools')
}

export function mcpCallTool(
  serverId: string,
  name: string,
  args: unknown,
): Promise<string> {
  return postJson<string>('/api/mcp/call', { serverId, name, args })
}

// ---------- RAG (knowledge bases) ----------

const kbPath = (id: string) => `/api/rag/kbs/${encodeURIComponent(id)}`

export function ragListKbs(): Promise<KnowledgeBase[]> {
  return getJson<KnowledgeBase[]>('/api/rag/kbs')
}

export function ragCreateKb(
  name: string,
  providerId: string | null,
  embedModel: string | null,
): Promise<KnowledgeBase> {
  return postJson<KnowledgeBase>('/api/rag/kbs', { name, providerId, embedModel })
}

export function ragUpdateKb(id: string, patch: KnowledgeBasePatch): Promise<void> {
  return send(kbPath(id), 'POST', patch)
}

export function ragDeleteKb(id: string): Promise<void> {
  return send(kbPath(id), 'DELETE')
}

export function ragListDocs(kbId: string): Promise<DocSummary[]> {
  return getJson<DocSummary[]>(`${kbPath(kbId)}/documents`)
}

export function ragCountChunks(kbId: string): Promise<number> {
  return getJson<number>(`${kbPath(kbId)}/count`)
}

export function ragDeleteDoc(docId: string): Promise<void> {
  return send(`/api/rag/documents/${encodeURIComponent(docId)}`, 'DELETE')
}

export function ragAddChunks(
  kbId: string,
  docId: string,
  source: string,
  items: ChunkInput[],
): Promise<number> {
  return postJson<number>(`${kbPath(kbId)}/chunks`, { docId, source, items })
}

export function ragSearch(
  kbId: string,
  embedding: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  return postJson<RetrievedChunk[]>(`${kbPath(kbId)}/search`, { embedding, topK })
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

// ---------- SQLite — semantic ops ----------

export function dbInit(): Promise<void> {
  // Server opens the DB on startup; nothing to do client-side.
  return Promise.resolve()
}

export function listConversations(): Promise<Conversation[]> {
  return getJson<Conversation[]>('/api/conversations')
}

export function createConversation(
  title: string,
  init?: ConversationInit,
): Promise<Conversation> {
  return postJson<Conversation>('/api/conversations', { title, init })
}

const conv = (id: string) => `/api/conversations/${encodeURIComponent(id)}`

export function updateConversationModel(
  id: string,
  providerId: string | null,
  model: string | null,
): Promise<void> {
  return send(`${conv(id)}/model`, 'POST', { providerId, model })
}

export function updateConversationTemperature(
  id: string,
  temperature: number | null,
): Promise<void> {
  return send(`${conv(id)}/temperature`, 'POST', { temperature })
}

export function updateConversationMaxTokens(
  id: string,
  maxTokens: number | null,
): Promise<void> {
  return send(`${conv(id)}/max_tokens`, 'POST', { maxTokens })
}

export function updateConversationSystemPrompt(
  id: string,
  systemPrompt: string | null,
): Promise<void> {
  return send(`${conv(id)}/system_prompt`, 'POST', { systemPrompt })
}

export function updateConversationTitle(id: string, title: string): Promise<void> {
  return send(`${conv(id)}/title`, 'POST', { title })
}

export function updateConversationPinned(id: string, pinned: boolean): Promise<void> {
  return send(`${conv(id)}/pinned`, 'POST', { pinned })
}

export function deleteConversation(id: string): Promise<void> {
  return send(conv(id), 'DELETE')
}

export function appendMessage(
  conversationId: string,
  role: Message['role'],
  content: string,
  attachments?: MessageAttachment[],
): Promise<Message> {
  return postJson<Message>(`${conv(conversationId)}/messages`, {
    role,
    content,
    attachments,
  })
}

export function listMessages(conversationId: string): Promise<Message[]> {
  return getJson<Message[]>(`${conv(conversationId)}/messages`)
}

export function deleteMessage(id: string): Promise<void> {
  return send(`/api/messages/${encodeURIComponent(id)}`, 'DELETE')
}

// Generic SQL has no web counterpart by design (the user chose semantic
// endpoints, not a SQL passthrough). Search / RAG / export will get their own
// semantic endpoints; until then these are unavailable in the browser.
export function dbSelect<T>(_sql: string, _params?: unknown[]): Promise<T> {
  return notImpl('dbSelect')
}

export function dbExecute(_sql: string, _params?: unknown[]): Promise<DbExecResult> {
  return notImpl('dbExecute')
}

// ---------- KV store ----------

const kv = (key: string) => `/api/kv/${encodeURIComponent(key)}`

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = await fetch(kv(key), { headers: authHeaders() })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export function kvSet<T>(key: string, value: T): Promise<void> {
  return send(kv(key), 'PUT', value)
}

export function kvDelete(key: string): Promise<void> {
  return send(kv(key), 'DELETE')
}

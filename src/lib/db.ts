// Data access goes through the `api` layer (Tauri commands on desktop, HTTP on
// web), all backed by taffy-core::db. Schema evolution + the query SQL live in
// Rust (see crates/taffy-core/src/db.rs).
import { api } from '../services/api'

export interface Conversation {
  id: string
  title: string
  created_at: number
  updated_at: number
  /** Per-conversation override of which provider to use. NULL = use global default. */
  provider_id?: string | null
  /** Per-conversation override of which model to use within the chosen provider. */
  model?: string | null
  /** Per-conversation temperature. NULL = use the global default. */
  temperature?: number | null
  /** 1 if the user has pinned this conversation to the top of the sidebar. */
  pinned?: number | null
  /** Per-conversation max output tokens. NULL = let Rust dispatch decide. */
  max_tokens?: number | null
  /** Per-conversation system prompt; injected at request time, NOT stored as
   *  a message row. NULL = no system message prepended. */
  system_prompt?: string | null
}

export interface MessageAttachment {
  id: string
  type: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** Base64 payload, no data: URL prefix. */
  data: string
  /** Extracted text for documents / OCR output for images. */
  text?: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  created_at: number
  attachments?: MessageAttachment[]
}

export async function initDb(): Promise<void> {
  // Open the DB; migrations run in Rust on plugin init.
  await api.dbInit()
}

export function uuid(): string {
  // Crypto.randomUUID exists in every Tauri webview target.
  return crypto.randomUUID()
}

// All data ops are SEMANTIC: they delegate to the backend driver
// (`services/api`), which runs them in taffy-core::db (Tauri command on desktop,
// HTTP route on web) — conversations, messages, search, RAG, export/import. The
// SQL lives in Rust; the frontend no longer issues any raw SQL.

export function listConversations(): Promise<Conversation[]> {
  return api.listConversations()
}

/** Optional initial-state for a new conversation. NULL/undefined on any
 *  field means "inherit the global default" (same semantics as the
 *  matching columns on the conversation row). Used to spin up a chat
 *  from an AssistantTemplate. */
export interface ConversationInit {
  providerId?: string | null
  model?: string | null
  temperature?: number | null
  maxTokens?: number | null
  systemPrompt?: string | null
}

export function createConversation(
  title: string,
  init?: ConversationInit,
): Promise<Conversation> {
  return api.createConversation(title, init)
}

/** Update the per-conversation provider/model override. Pass null to clear. */
export function updateConversationModel(
  id: string,
  providerId: string | null,
  model: string | null,
): Promise<void> {
  return api.updateConversationModel(id, providerId, model)
}

/** Update only the per-conversation temperature override. Pass null to clear. */
export function updateConversationTemperature(
  id: string,
  temperature: number | null,
): Promise<void> {
  return api.updateConversationTemperature(id, temperature)
}

/** Update only the per-conversation maxTokens override. Pass null to clear. */
export function updateConversationMaxTokens(
  id: string,
  maxTokens: number | null,
): Promise<void> {
  return api.updateConversationMaxTokens(id, maxTokens)
}

/** Update only the per-conversation system prompt. Pass null/'' to clear. */
export function updateConversationSystemPrompt(
  id: string,
  systemPrompt: string | null,
): Promise<void> {
  return api.updateConversationSystemPrompt(id, systemPrompt)
}

export function appendMessage(
  conversationId: string,
  role: Message['role'],
  content: string,
  attachments?: MessageAttachment[],
): Promise<Message> {
  return api.appendMessage(conversationId, role, content, attachments)
}

export function listMessages(conversationId: string): Promise<Message[]> {
  return api.listMessages(conversationId)
}

/** Delete a single message. Used by the Regenerate flow to drop the last
 *  assistant reply before re-streaming from the same history. */
export function deleteMessage(id: string): Promise<void> {
  return api.deleteMessage(id)
}

/** Patch the title of a conversation. */
export function updateConversationTitle(id: string, title: string): Promise<void> {
  return api.updateConversationTitle(id, title)
}

/** Pin / unpin a conversation so it bubbles above the recency sort. */
export function updateConversationPinned(id: string, pinned: boolean): Promise<void> {
  return api.updateConversationPinned(id, pinned)
}

/** Delete a conversation; its messages cascade. */
export function deleteConversation(id: string): Promise<void> {
  return api.deleteConversation(id)
}

// ---------- Full-text search (FTS5) ----------

/** Raw FTS hit from the backend: `excerpt_raw` still carries the snippet marker
 *  bytes (the frontend escapes + marks them up). Mirrors Rust `SearchHit`. */
export interface SearchHitRaw {
  message_id: string
  conversation_id: string
  conversation_title: string
  role: Message['role']
  excerpt_raw: string
  created_at: number
}

export interface SearchHit {
  message_id: string
  conversation_id: string
  conversation_title: string
  role: Message['role']
  /** HTML-safe string with <b>…</b> wrapping the matched terms. Already
   *  escaped — render via dangerouslySetInnerHTML. */
  excerpt: string
  created_at: number
}

/** Convert a raw user query into a safe FTS5 MATCH expression. Each
 *  whitespace-separated token is double-quoted (so FTS5 operator characters
 *  the user typed land as literal text), then implicit-AND'd. A trailing
 *  `*` survives outside the quotes so `claud*` still does prefix search. */
function toFtsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const hasStar = t.endsWith('*') && t.length > 1
      const body = hasStar ? t.slice(0, -1) : t
      const quoted = `"${body.replace(/"/g, '""')}"`
      return hasStar ? `${quoted}*` : quoted
    })
    .join(' ')
}

// FTS5 snippet() marker bytes. Built via fromCharCode so the source file
// stays plain ASCII — control bytes in JS sources confuse editors, diff
// tools, and Edit-by-string-match toolchains. The SQL side emits these
// via char(1) / char(2), so they round-trip exactly.
const FTS_MARKER_START = String.fromCharCode(1)
const FTS_MARKER_END = String.fromCharCode(2)
const FTS_MARKER_START_RE = new RegExp(FTS_MARKER_START, 'g')
const FTS_MARKER_END_RE = new RegExp(FTS_MARKER_END, 'g')

/** HTML-escape `raw` then swap the FTS5 marker bytes for <b>…</b>. The
 *  markers are control chars that can't appear in user text, so the
 *  ordering (escape first, then markup) is collision-free. */
function escapeAndMarkup(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  return escaped
    .replace(FTS_MARKER_START_RE, '<b>')
    .replace(FTS_MARKER_END_RE, '</b>')
}

/** Run an FTS5 MATCH and return top hits with HTML-marked excerpts. Empty
 *  / whitespace-only input short-circuits to no hits. The MATCH query is built
 *  here; the backend (taffy-core::db) runs it and returns marker-tagged
 *  snippets which we HTML-escape then mark up. snippet() emits the markers via
 *  char(1)/char(2), so they round-trip exactly. */
export async function searchMessages(
  query: string,
  limit = 50,
): Promise<SearchHit[]> {
  const fts = toFtsQuery(query)
  if (fts.length === 0) return []
  let rows: SearchHitRaw[]
  try {
    rows = await api.searchMessages(fts, limit)
  } catch (e) {
    // Malformed FTS5 syntax (`AND` alone, mismatched quotes after our escape,
    // …) shouldn't crash the UI — return empty results and surface via the
    // caller's error path if needed.
    console.warn('FTS5 search failed:', e)
    return []
  }
  return rows.map((r) => ({
    message_id: r.message_id,
    conversation_id: r.conversation_id,
    conversation_title: r.conversation_title,
    role: r.role,
    excerpt: escapeAndMarkup(r.excerpt_raw ?? ''),
    created_at: r.created_at,
  }))
}

// ---------- JSON export / import ----------

/** Bumped whenever the export JSON shape changes in a non-additive way.
 *  Additive changes (a new optional field) keep schemaVersion the same;
 *  field removal / semantic shifts get a new number + a migration branch
 *  inside importConversationsFromJson. */
export const EXPORT_SCHEMA_VERSION = 1

export interface ExportedMessage {
  id: string
  role: Message['role']
  content: string
  created_at: number
  attachments: MessageAttachment[] | null
}

export interface ExportedConversation {
  id: string
  title: string
  created_at: number
  updated_at: number
  provider_id: string | null
  model: string | null
  temperature: number | null
  /** Optional in the export so v1 files written before pinning land sanely. */
  pinned?: number | null
  /** Optional in the export — added in app schema v6. */
  max_tokens?: number | null
  /** Optional in the export — added in app schema v6. */
  system_prompt?: string | null
  messages: ExportedMessage[]
}

export interface ExportFile {
  schemaVersion: number
  exportedAt: number
  appVersion?: string
  conversations: ExportedConversation[]
}

export interface ImportSummary {
  conversations: number
  messages: number
}

/** One message in the normalized import payload (no id — the backend mints
 *  fresh ones). Mirrors the fields the Rust importer reads. */
export interface ImportMessage {
  role: Message['role']
  content: string
  created_at: number
  attachments: MessageAttachment[] | null
}

/** One conversation in the normalized import payload (no id — backend-minted). */
export interface ImportConversation {
  title: string
  created_at: number
  updated_at: number
  provider_id: string | null
  model: string | null
  temperature: number | null
  pinned: number
  max_tokens: number | null
  system_prompt: string | null
  messages: ImportMessage[]
}

/** Serialize every conversation + its messages into a single JSON document.
 *  The backend gathers the rows (taffy-core::db); we just wrap them in the
 *  export envelope. Attachments (base64) are embedded — exports are
 *  self-contained and re-import on a fresh machine with no external files. */
export async function exportConversationsToJson(appVersion?: string): Promise<string> {
  const conversations = await api.exportConversations()
  const doc: ExportFile = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion,
    conversations,
  }
  return JSON.stringify(doc, null, 2)
}

/** Parse + validate an export JSON, then hand a normalized payload to the
 *  backend, which inserts it under fresh UUIDs (re-importing the same file
 *  produces independent copies instead of clobbering existing rows). Validation
 *  stays here so arbitrary files are sanitized before they reach SQL. */
export async function importConversationsFromJson(json: string): Promise<ImportSummary> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`)
  }
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error('Import file is not a JSON object.')
  }
  const doc = parsed as Partial<ExportFile>
  if (typeof doc.schemaVersion !== 'number') {
    throw new Error('Import file is missing schemaVersion.')
  }
  if (doc.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    // Add migration branches here when EXPORT_SCHEMA_VERSION bumps.
    throw new Error(
      `Unsupported export schema (got ${doc.schemaVersion}, expected ${EXPORT_SCHEMA_VERSION}).`,
    )
  }
  if (!Array.isArray(doc.conversations)) {
    throw new Error('Import file has no `conversations` array.')
  }

  // Normalize each conversation/message, applying the same defaults the old
  // inline INSERT did. The backend then inserts verbatim with minted UUIDs.
  const convos: ImportConversation[] = []
  for (const c of doc.conversations) {
    if (!c || typeof c !== 'object') continue
    const createdAt = typeof c.created_at === 'number' ? c.created_at : Date.now()
    const updatedAt = typeof c.updated_at === 'number' ? c.updated_at : createdAt
    const messages: ImportMessage[] = []
    const msgs = Array.isArray(c.messages) ? c.messages : []
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue
      const role = m.role
      if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
      messages.push({
        role,
        content: typeof m.content === 'string' ? m.content : '',
        created_at: typeof m.created_at === 'number' ? m.created_at : Date.now(),
        attachments:
          Array.isArray(m.attachments) && m.attachments.length > 0 ? m.attachments : null,
      })
    }
    convos.push({
      title: typeof c.title === 'string' && c.title.length > 0 ? c.title : 'Imported conversation',
      created_at: createdAt,
      updated_at: updatedAt,
      provider_id: c.provider_id ?? null,
      model: c.model ?? null,
      temperature: typeof c.temperature === 'number' ? c.temperature : null,
      // pinned is optional in the export schema; treat anything truthy as 1.
      pinned: c.pinned ? 1 : 0,
      max_tokens: typeof c.max_tokens === 'number' && c.max_tokens > 0 ? c.max_tokens : null,
      system_prompt:
        typeof c.system_prompt === 'string' && c.system_prompt.length > 0
          ? c.system_prompt
          : null,
      messages,
    })
  }
  return api.importConversations(convos)
}

// SQLite access goes through the Tauri SQL plugin (sqlx under the hood).
// Schema evolution lives in Rust (see src-tauri/src/lib.rs Migration list).
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

/** SQLite gives us TEXT for the attachments column; parse JSON safely. */
function parseAttachments(raw: unknown): MessageAttachment[] | undefined {
  if (raw == null || raw === '') return undefined
  if (typeof raw !== 'string') return undefined
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Minimal DB surface used across this module + rag.ts. Backed by the backend
 *  driver (`services/api`): Tauri → plugin-sql; web → server SQL endpoint. The
 *  `.select` / `.execute` shape is kept identical to tauri-plugin-sql so all
 *  existing call sites work unchanged. */
export interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T>
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>
}

const dbFacade: Db = {
  select<T>(sql: string, params?: unknown[]): Promise<T> {
    return api.dbSelect<T>(sql, params)
  },
  execute(sql: string, params?: unknown[]) {
    return api.dbExecute(sql, params)
  },
}

async function db(): Promise<Db> {
  return dbFacade
}

/** Shared connection accessor for sibling modules (e.g. rag.ts). */
export function getDb(): Promise<Db> {
  return db()
}

export async function initDb(): Promise<void> {
  // Open the DB; migrations run in Rust on plugin init.
  await api.dbInit()
}

export function uuid(): string {
  // Crypto.randomUUID exists in every Tauri webview target.
  return crypto.randomUUID()
}

export async function listConversations(): Promise<Conversation[]> {
  const conn = await db()
  // Pinned rows bubble to the top; everything else falls back to recency.
  return conn.select<Conversation[]>(
    'SELECT id, title, created_at, updated_at, provider_id, model, temperature, pinned, max_tokens, system_prompt FROM conversations ORDER BY pinned DESC, updated_at DESC',
  )
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

export async function createConversation(
  title: string,
  init?: ConversationInit,
): Promise<Conversation> {
  const conn = await db()
  const now = Date.now()
  // Normalize empty string system_prompt to NULL so "IS NOT NULL" stays a
  // valid "has a system prompt at all?" predicate (same rule we use for
  // updateConversationSystemPrompt below).
  const systemPrompt =
    init?.systemPrompt && init.systemPrompt.length > 0 ? init.systemPrompt : null
  const row: Conversation = {
    id: uuid(),
    title,
    created_at: now,
    updated_at: now,
    provider_id: init?.providerId ?? null,
    model: init?.model ?? null,
    temperature: init?.temperature ?? null,
    max_tokens: init?.maxTokens ?? null,
    system_prompt: systemPrompt,
  }
  await conn.execute(
    'INSERT INTO conversations (id, title, created_at, updated_at, provider_id, model, temperature, max_tokens, system_prompt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      row.id,
      row.title,
      row.created_at,
      row.updated_at,
      row.provider_id,
      row.model,
      row.temperature,
      row.max_tokens,
      row.system_prompt,
    ],
  )
  return row
}

/** Update the per-conversation provider/model override. Pass null to clear. */
export async function updateConversationModel(
  id: string,
  providerId: string | null,
  model: string | null,
): Promise<void> {
  const conn = await db()
  await conn.execute(
    'UPDATE conversations SET provider_id = $1, model = $2, updated_at = $3 WHERE id = $4',
    [providerId, model, Date.now(), id],
  )
}

/** Update only the per-conversation temperature override. Pass null to clear. */
export async function updateConversationTemperature(
  id: string,
  temperature: number | null,
): Promise<void> {
  const conn = await db()
  await conn.execute(
    'UPDATE conversations SET temperature = $1, updated_at = $2 WHERE id = $3',
    [temperature, Date.now(), id],
  )
}

/** Update only the per-conversation maxTokens override. Pass null to clear. */
export async function updateConversationMaxTokens(
  id: string,
  maxTokens: number | null,
): Promise<void> {
  const conn = await db()
  await conn.execute(
    'UPDATE conversations SET max_tokens = $1, updated_at = $2 WHERE id = $3',
    [maxTokens, Date.now(), id],
  )
}

/** Update only the per-conversation system prompt. Pass null/'' to clear. */
export async function updateConversationSystemPrompt(
  id: string,
  systemPrompt: string | null,
): Promise<void> {
  const conn = await db()
  // Normalize empty strings to NULL so "system_prompt IS NOT NULL" stays the
  // canonical "is there a system prompt at all?" predicate.
  const normalized = systemPrompt && systemPrompt.length > 0 ? systemPrompt : null
  await conn.execute(
    'UPDATE conversations SET system_prompt = $1, updated_at = $2 WHERE id = $3',
    [normalized, Date.now(), id],
  )
}

export async function appendMessage(
  conversationId: string,
  role: Message['role'],
  content: string,
  attachments?: MessageAttachment[],
): Promise<Message> {
  const conn = await db()
  const now = Date.now()
  const row: Message = {
    id: uuid(),
    conversation_id: conversationId,
    role,
    content,
    created_at: now,
    attachments,
  }
  const attachmentsJson =
    attachments && attachments.length > 0 ? JSON.stringify(attachments) : null
  await conn.execute(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) VALUES ($1, $2, $3, $4, $5, $6)',
    [row.id, row.conversation_id, row.role, row.content, row.created_at, attachmentsJson],
  )
  await conn.execute(
    'UPDATE conversations SET updated_at = $1 WHERE id = $2',
    [now, conversationId],
  )
  return row
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  const conn = await db()
  type RawMessage = Omit<Message, 'attachments'> & { attachments: unknown }
  const rows = await conn.select<RawMessage[]>(
    'SELECT id, conversation_id, role, content, created_at, attachments FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId],
  )
  return rows.map((r) => ({ ...r, attachments: parseAttachments(r.attachments) }))
}

/** Delete a single message. Used by the Regenerate flow to drop the last
 *  assistant reply before re-streaming from the same history. */
export async function deleteMessage(id: string): Promise<void> {
  const conn = await db()
  await conn.execute('DELETE FROM messages WHERE id = $1', [id])
}

/** Patch the title of a conversation. */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const conn = await db()
  await conn.execute(
    'UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3',
    [title, Date.now(), id],
  )
}

/** Pin / unpin a conversation so it bubbles above the recency sort. */
export async function updateConversationPinned(id: string, pinned: boolean): Promise<void> {
  const conn = await db()
  // Intentionally do NOT touch updated_at — pinning shouldn't masquerade as
  // "new activity" the way renaming does, since it's a layout-only flip.
  await conn.execute(
    'UPDATE conversations SET pinned = $1 WHERE id = $2',
    [pinned ? 1 : 0, id],
  )
}

/** Delete a conversation; messages cascade via the FK on the messages table
 *  if foreign_keys are on, but we delete explicitly first to make the
 *  behavior portable across plugin-sql connection settings. */
export async function deleteConversation(id: string): Promise<void> {
  const conn = await db()
  await conn.execute('DELETE FROM messages WHERE conversation_id = $1', [id])
  await conn.execute('DELETE FROM conversations WHERE id = $1', [id])
}

// ---------- Full-text search (FTS5) ----------

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
 *  / whitespace-only input short-circuits to no hits. */
export async function searchMessages(
  query: string,
  limit = 50,
): Promise<SearchHit[]> {
  const fts = toFtsQuery(query)
  if (fts.length === 0) return []
  const conn = await db()
  // Snippet markers are control characters so they cannot collide with user
  // text. We HTML-escape the surrounding text in JS, then swap markers for
  // <b>/</b>. snippet() takes: (table, col, start, end, ellip, ntokens).
  type Row = {
    message_id: string
    conversation_id: string
    conversation_title: string
    role: Message['role']
    excerpt_raw: string
    created_at: number
  }
  let rows: Row[]
  try {
    rows = await conn.select<Row[]>(
      'SELECT m.id AS message_id, m.conversation_id AS conversation_id, ' +
        "c.title AS conversation_title, m.role AS role, " +
        "snippet(messages_fts, 0, char(1), char(2), char(0x2026), 16) AS excerpt_raw, " +
        'm.created_at AS created_at ' +
        'FROM messages_fts ' +
        'JOIN messages m ON m.rowid = messages_fts.rowid ' +
        'JOIN conversations c ON c.id = m.conversation_id ' +
        'WHERE messages_fts MATCH $1 ' +
        'ORDER BY rank LIMIT $2',
      [fts, limit],
    )
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

/** Serialize every conversation + its messages into a single JSON document.
 *  Attachments (base64) are embedded — exports are self-contained and can
 *  re-import on a fresh machine with no external files. */
export async function exportConversationsToJson(appVersion?: string): Promise<string> {
  const conn = await db()
  const convos = await conn.select<Conversation[]>(
    'SELECT id, title, created_at, updated_at, provider_id, model, temperature, pinned, max_tokens, system_prompt FROM conversations ORDER BY created_at ASC',
  )
  type RawMessage = Omit<Message, 'attachments'> & { attachments: unknown }
  const exported: ExportedConversation[] = []
  for (const c of convos) {
    const rows = await conn.select<RawMessage[]>(
      'SELECT id, conversation_id, role, content, created_at, attachments FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [c.id],
    )
    exported.push({
      id: c.id,
      title: c.title,
      created_at: c.created_at,
      updated_at: c.updated_at,
      provider_id: c.provider_id ?? null,
      model: c.model ?? null,
      temperature: c.temperature ?? null,
      pinned: c.pinned ?? 0,
      max_tokens: c.max_tokens ?? null,
      system_prompt: c.system_prompt ?? null,
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        created_at: r.created_at,
        attachments: parseAttachments(r.attachments) ?? null,
      })),
    })
  }
  const doc: ExportFile = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion,
    conversations: exported,
  }
  return JSON.stringify(doc, null, 2)
}

/** Insert conversations + messages from an export JSON. New UUIDs are minted
 *  so re-importing the same file produces independent copies instead of
 *  clobbering existing rows. Returns counts of what was actually inserted. */
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

  const conn = await db()
  let convCount = 0
  let msgCount = 0
  // Not a real transaction (sqlx pool may swap connections between awaits),
  // so we tolerate partial failures: if an INSERT throws, prior rows stay,
  // and the caller can retry. Fresh UUIDs make a retry additive, not clobbery.
  for (const c of doc.conversations) {
    if (!c || typeof c !== 'object') continue
    const newConvId = uuid()
    const createdAt = typeof c.created_at === 'number' ? c.created_at : Date.now()
    const updatedAt = typeof c.updated_at === 'number' ? c.updated_at : createdAt
    await conn.execute(
      'INSERT INTO conversations (id, title, created_at, updated_at, provider_id, model, temperature, pinned, max_tokens, system_prompt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [
        newConvId,
        typeof c.title === 'string' && c.title.length > 0 ? c.title : 'Imported conversation',
        createdAt,
        updatedAt,
        c.provider_id ?? null,
        c.model ?? null,
        typeof c.temperature === 'number' ? c.temperature : null,
        // pinned is optional in the export schema; treat anything truthy as 1.
        c.pinned ? 1 : 0,
        typeof c.max_tokens === 'number' && c.max_tokens > 0 ? c.max_tokens : null,
        typeof c.system_prompt === 'string' && c.system_prompt.length > 0 ? c.system_prompt : null,
      ],
    )
    convCount += 1

    const msgs = Array.isArray(c.messages) ? c.messages : []
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue
      const role = m.role
      if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
      const content = typeof m.content === 'string' ? m.content : ''
      const ts = typeof m.created_at === 'number' ? m.created_at : Date.now()
      const attachments = Array.isArray(m.attachments) && m.attachments.length > 0
        ? JSON.stringify(m.attachments)
        : null
      await conn.execute(
        'INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuid(), newConvId, role, content, ts, attachments],
      )
      msgCount += 1
    }
  }
  return { conversations: convCount, messages: msgCount }
}

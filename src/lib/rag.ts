// Local RAG — knowledge bases + brute-force vector retrieval.
//
// Storage: SQLite (migration v8) holds `knowledge_bases` and `knowledge_chunks`
// with embeddings as a JSON float array in TEXT. Embeddings are computed in
// Rust (`embed_texts`, keeps the key out of the webview). Search loads a KB's
// chunks and ranks them by cosine in JS — fine at local-app scale (thousands of
// chunks), and it avoids a native sqlite-vec extension dependency.
import { invoke } from '@tauri-apps/api/core'
import { getDb, uuid } from './db'
import { getProvider, readApiKey, type AppSettings } from './settings'

export interface KnowledgeBase {
  id: string
  name: string
  /** Provider used for embeddings (id into AppSettings.providers). */
  provider_id: string | null
  embed_model: string | null
  /** Embedding dimensionality, captured on first insert. */
  dim: number | null
  created_at: number
}

export interface KnowledgeChunk {
  id: string
  kb_id: string
  doc_id: string
  source: string
  text: string
  created_at: number
}

export interface RetrievedChunk {
  text: string
  source: string
  score: number
}

// ---------- embeddings ----------

interface EmbedRequest {
  provider: string
  baseUrl?: string
  apiKey?: string
  model: string
  input: string[]
}

function embedTexts(req: EmbedRequest): Promise<number[][]> {
  return invoke<number[][]>('embed_texts', { req })
}

/** Resolve the embedding HTTP target for a KB from app settings. */
async function embedFor(
  settings: AppSettings,
  kb: { provider_id: string | null; embed_model: string | null },
  input: string[],
): Promise<number[][]> {
  const provider = getProvider(settings, kb.provider_id ?? undefined)
  if (!provider) throw new Error('Embedding provider not configured.')
  if (!kb.embed_model) throw new Error('No embedding model set for this knowledge base.')
  const apiKey = await readApiKey(provider.id)
  return embedTexts({
    provider: provider.kind === 'custom' ? provider.name.toLowerCase() : provider.kind,
    baseUrl: provider.baseUrl,
    apiKey,
    model: kb.embed_model,
    input,
  })
}

// ---------- chunking ----------

/** Split text into overlapping chunks on paragraph / sentence boundaries.
 *  Keeps chunks near `target` chars with `overlap` carryover for context. */
export function chunkText(text: string, target = 900, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  // Prefer paragraph splits; fall back to hard slicing for very long blocks.
  const paras = clean.split(/\n{2,}/)
  const chunks: string[] = []
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  for (const p of paras) {
    if (p.length > target * 1.5) {
      flush()
      for (let i = 0; i < p.length; i += target - overlap) {
        chunks.push(p.slice(i, i + target).trim())
      }
      continue
    }
    if (buf.length + p.length + 2 > target) {
      flush()
      // Seed the next buffer with a tail of the previous chunk for overlap.
      const prev = chunks[chunks.length - 1] ?? ''
      buf = prev.slice(Math.max(0, prev.length - overlap)) + '\n\n'
    }
    buf += (buf ? '\n\n' : '') + p
  }
  flush()
  return chunks.filter(Boolean)
}

// ---------- cosine ----------

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------- knowledge base CRUD ----------

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  const conn = await getDb()
  return conn.select<KnowledgeBase[]>(
    'SELECT id, name, provider_id, embed_model, dim, created_at FROM knowledge_bases ORDER BY created_at DESC',
  )
}

export async function createKnowledgeBase(
  name: string,
  providerId: string | null,
  embedModel: string | null,
): Promise<KnowledgeBase> {
  const conn = await getDb()
  const row: KnowledgeBase = {
    id: uuid(),
    name,
    provider_id: providerId,
    embed_model: embedModel,
    dim: null,
    created_at: Date.now(),
  }
  await conn.execute(
    'INSERT INTO knowledge_bases (id, name, provider_id, embed_model, dim, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [row.id, row.name, row.provider_id, row.embed_model, row.dim, row.created_at],
  )
  return row
}

export async function updateKnowledgeBase(
  id: string,
  patch: Partial<Pick<KnowledgeBase, 'name' | 'provider_id' | 'embed_model'>>,
): Promise<void> {
  const conn = await getDb()
  const cur = await conn.select<KnowledgeBase[]>(
    'SELECT id, name, provider_id, embed_model, dim, created_at FROM knowledge_bases WHERE id = $1',
    [id],
  )
  const kb = cur[0]
  if (!kb) return
  await conn.execute(
    'UPDATE knowledge_bases SET name=$1, provider_id=$2, embed_model=$3 WHERE id=$4',
    [
      patch.name ?? kb.name,
      patch.provider_id !== undefined ? patch.provider_id : kb.provider_id,
      patch.embed_model !== undefined ? patch.embed_model : kb.embed_model,
      id,
    ],
  )
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  const conn = await getDb()
  await conn.execute('DELETE FROM knowledge_chunks WHERE kb_id = $1', [id])
  await conn.execute('DELETE FROM knowledge_bases WHERE id = $1', [id])
}

export interface DocSummary {
  doc_id: string
  source: string
  chunks: number
}

export async function listDocuments(kbId: string): Promise<DocSummary[]> {
  const conn = await getDb()
  return conn.select<DocSummary[]>(
    'SELECT doc_id, source, COUNT(*) AS chunks FROM knowledge_chunks WHERE kb_id = $1 GROUP BY doc_id, source ORDER BY MAX(created_at) DESC',
    [kbId],
  )
}

export async function countChunks(kbId: string): Promise<number> {
  const conn = await getDb()
  const r = await conn.select<{ n: number }[]>(
    'SELECT COUNT(*) AS n FROM knowledge_chunks WHERE kb_id = $1',
    [kbId],
  )
  return r[0]?.n ?? 0
}

export async function deleteDocument(docId: string): Promise<void> {
  const conn = await getDb()
  await conn.execute('DELETE FROM knowledge_chunks WHERE doc_id = $1', [docId])
}

/** Chunk + embed + store a document into a KB. Returns the number of chunks
 *  indexed. Embeds in batches to keep payloads small. */
export async function addDocument(
  settings: AppSettings,
  kb: KnowledgeBase,
  source: string,
  text: string,
): Promise<number> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return 0
  const conn = await getDb()
  const docId = uuid()
  const now = Date.now()
  let dim = kb.dim ?? null

  const BATCH = 32
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH)
    const vectors = await embedFor(settings, kb, slice)
    for (let j = 0; j < slice.length; j++) {
      const vec = vectors[j] ?? []
      if (dim == null && vec.length > 0) dim = vec.length
      await conn.execute(
        'INSERT INTO knowledge_chunks (id, kb_id, doc_id, source, text, embedding, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuid(), kb.id, docId, source, slice[j], JSON.stringify(vec), now],
      )
    }
  }
  if (dim != null && kb.dim == null) {
    await conn.execute('UPDATE knowledge_bases SET dim = $1 WHERE id = $2', [dim, kb.id])
  }
  return chunks.length
}

/** Embed the query, score every chunk in the KB by cosine, return top-k. */
export async function searchKnowledge(
  settings: AppSettings,
  kb: KnowledgeBase,
  query: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const conn = await getDb()
  const rows = await conn.select<{ text: string; source: string; embedding: string }[]>(
    'SELECT text, source, embedding FROM knowledge_chunks WHERE kb_id = $1',
    [kb.id],
  )
  if (rows.length === 0) return []
  const [qvec] = await embedFor(settings, kb, [query])
  if (!qvec || qvec.length === 0) return []
  const scored = rows.map((r) => {
    let vec: number[] = []
    try {
      vec = JSON.parse(r.embedding)
    } catch {
      vec = []
    }
    return { text: r.text, source: r.source, score: cosine(qvec, vec) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).filter((s) => s.score > 0)
}

/** Build the retrieval-augmented context block to prepend to a chat request. */
export function buildContextBlock(hits: RetrievedChunk[]): string {
  if (hits.length === 0) return ''
  const body = hits
    .map((h, i) => `[${i + 1}] (${h.source})\n${h.text}`)
    .join('\n\n')
  return (
    'Use the following retrieved context to answer the user. ' +
    'If it is not relevant, rely on your own knowledge.\n\n' +
    '<context>\n' +
    body +
    '\n</context>'
  )
}

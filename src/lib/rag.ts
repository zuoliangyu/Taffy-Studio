// Local RAG — knowledge bases + brute-force vector retrieval.
//
// Storage + cosine search live in the backend (taffy-core::db; migration v8 holds
// `knowledge_bases` and `knowledge_chunks`), reached through the `api` layer so
// the same code runs on desktop (Tauri commands) and web (HTTP routes). This
// module keeps the parts that need frontend context: chunking (pure text) and
// embedding (provider/key resolution lives in `settings`). Embeddings are
// computed by the backend (`embedTexts`, keeps the key out of the webview) and
// the vectors are shipped to the store/search endpoints.
import { api } from '../services/api'
import { uuid } from './db'
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

/** The subset of a KB the editor can patch. Absent keys are left unchanged;
 *  an explicit null clears provider_id / embed_model. */
export type KnowledgeBasePatch = Partial<
  Pick<KnowledgeBase, 'name' | 'provider_id' | 'embed_model'>
>

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

export interface DocSummary {
  doc_id: string
  source: string
  chunks: number
}

/** One chunk to index: text + its embedding (computed frontend-side). Mirrors
 *  the Rust `ChunkInput`. */
export interface ChunkInput {
  text: string
  embedding: number[]
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
  return api.embedTexts(req)
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

// ---------- knowledge base CRUD ----------

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return api.ragListKbs()
}

export function createKnowledgeBase(
  name: string,
  providerId: string | null,
  embedModel: string | null,
): Promise<KnowledgeBase> {
  return api.ragCreateKb(name, providerId, embedModel)
}

export function updateKnowledgeBase(
  id: string,
  patch: KnowledgeBasePatch,
): Promise<void> {
  return api.ragUpdateKb(id, patch)
}

export function deleteKnowledgeBase(id: string): Promise<void> {
  return api.ragDeleteKb(id)
}

export function listDocuments(kbId: string): Promise<DocSummary[]> {
  return api.ragListDocs(kbId)
}

export function countChunks(kbId: string): Promise<number> {
  return api.ragCountChunks(kbId)
}

export function deleteDocument(docId: string): Promise<void> {
  return api.ragDeleteDoc(docId)
}

/** Chunk + embed + store a document into a KB. Returns the number of chunks
 *  indexed. Embeds (and stores) in batches to keep payloads small. */
export async function addDocument(
  settings: AppSettings,
  kb: KnowledgeBase,
  source: string,
  text: string,
): Promise<number> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return 0
  const docId = uuid()

  const BATCH = 32
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH)
    const vectors = await embedFor(settings, kb, slice)
    const items: ChunkInput[] = slice.map((t, j) => ({
      text: t,
      embedding: vectors[j] ?? [],
    }))
    await api.ragAddChunks(kb.id, docId, source, items)
  }
  return chunks.length
}

/** Embed the query, then have the backend score every chunk in the KB by cosine
 *  and return the top-k positive hits. */
export async function searchKnowledge(
  settings: AppSettings,
  kb: KnowledgeBase,
  query: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const [qvec] = await embedFor(settings, kb, [query])
  if (!qvec || qvec.length === 0) return []
  return api.ragSearch(kb.id, qvec, topK)
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

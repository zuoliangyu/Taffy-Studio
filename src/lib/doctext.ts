// Client-side document → text extraction for non-image attachments.
//
// Why client-side: it sidesteps the three different file-upload APIs across
// OpenAI / Anthropic / Gemini. We pull the text out here and splice it into
// the prompt with a `[Attached document: name]` frame (see buildAttachmentText
// in attachments.ts), so every provider sees the content as plain text.
//
// PDF goes through pdfjs-dist; the worker is loaded from the bundled module via
// Vite's `?url` import so it works offline (no CDN). Plain-text formats
// (txt / md / csv / json / code) are read directly.
import type { Attachment } from './llm'

/** MIME / extension sniffing for the formats we can extract text from. */
export function isPdf(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|ini|log|xml|html?|css|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|hpp|rb|php|sh|sql)$/i

export function isPlainText(file: { name: string; type: string }): boolean {
  return file.type.startsWith('text/') || TEXT_EXT.test(file.name)
}

/** Can we extract text from this file at all? */
export function isExtractable(file: { name: string; type: string }): boolean {
  return isPdf(file) || isPlainText(file)
}

/** Extract text from a PDF File using pdfjs-dist. Loaded lazily so the ~300KB
 *  pdf.js core only ships to users who actually attach a PDF. */
async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  // Vite resolves this to a hashed URL at build time; the worker runs offline.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const buf = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const out: string[] = []
  const max = Math.min(doc.numPages, 200) // sanity cap
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const line = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) out.push(line)
  }
  await doc.destroy()
  return out.join('\n\n')
}

/** Extract text from an extractable file. Returns '' if the file isn't a
 *  recognized text/PDF type. */
export async function extractText(file: File): Promise<string> {
  if (isPdf(file)) {
    try {
      return await extractPdf(file)
    } catch (e) {
      console.warn('PDF extraction failed:', e)
      return ''
    }
  }
  if (isPlainText(file)) {
    try {
      return await file.text()
    } catch {
      return ''
    }
  }
  return ''
}

/** Build the wire-content prefix for a message, folding in any extracted
 *  document text from non-image attachments. Image attachments are left for
 *  the vision path (or OCR, which lands here as `text` too). */
export function attachmentTextBlock(attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return ''
  const blocks: string[] = []
  for (const a of attachments) {
    const text = a.text?.trim()
    if (!text) continue
    const label = a.type === 'image' ? 'Image text (OCR)' : 'Attached document'
    blocks.push(`[${label}: ${a.name}]\n${text}`)
  }
  return blocks.join('\n\n')
}

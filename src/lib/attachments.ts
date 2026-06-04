// Convert a File / Blob into a base64 string (no data: URL prefix).
// We keep payloads as plain base64 so the Rust side can format them however
// each provider wants (data URL for OpenAI, raw base64 for Anthropic/Gemini).
import { extractText, isExtractable } from './doctext'
import type { Attachment } from './llm'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 20 MB hard cap

export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 20 MB.`,
    )
  }
  const isImage = file.type.startsWith('image/')
  const data = await fileToBase64(file)
  // For non-image documents we recognize (PDF / txt / md / code), pull the
  // text out now so it can be spliced into the prompt at send time. Images
  // get text lazily via OCR only if the user asks for it.
  let text: string | undefined
  if (!isImage && isExtractable(file)) {
    const extracted = await extractText(file)
    if (extracted) text = extracted
  }
  return {
    id: crypto.randomUUID(),
    type: isImage ? 'image' : 'file',
    name: file.name || 'attachment',
    mime: file.type || 'application/octet-stream',
    size: file.size,
    data,
    text,
  }
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      // FileReader.readAsDataURL gives "data:<mime>;base64,<payload>".
      // We only want the payload portion.
      const s = String(r.result ?? '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = () => reject(r.error ?? new Error('Could not read file'))
    r.readAsDataURL(file)
  })
}

/** Build a `data:` URL suitable for an <img src=...>. */
export function attachmentToDataUrl(a: { mime: string; data: string }): string {
  return `data:${a.mime};base64,${a.data}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

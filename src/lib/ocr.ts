// Optional OCR for image attachments, used when the target model isn't
// vision-capable. Powered by tesseract.js (wasm). Lazy-loaded so the heavy
// wasm + worker only download when the user actually triggers OCR.
//
// Language data: tesseract.js fetches traineddata for the requested languages
// on first use (English + Chinese-simplified here). That first run needs
// network; results are cached by the browser afterwards. For a fully offline
// build you'd host the .traineddata files yourself and point `langPath` at
// them — left as a follow-up to keep the dependency footprint sane.
import { attachmentToDataUrl } from './attachments'
import type { Attachment } from './llm'

let _worker: import('tesseract.js').Worker | null = null
let _loading: Promise<import('tesseract.js').Worker> | null = null

async function getWorker(): Promise<import('tesseract.js').Worker> {
  if (_worker) return _worker
  if (_loading) return _loading
  _loading = (async () => {
    const { createWorker } = await import('tesseract.js')
    // eng + chi_sim covers the common bilingual case for this app's audience.
    const w = await createWorker(['eng', 'chi_sim'])
    _worker = w
    return w
  })()
  return _loading
}

/** Run OCR over an image attachment and return the recognized text (trimmed).
 *  Returns '' on failure rather than throwing — OCR is best-effort. */
export async function ocrImage(att: Attachment): Promise<string> {
  if (att.type !== 'image') return ''
  try {
    const worker = await getWorker()
    const url = attachmentToDataUrl(att)
    const { data } = await worker.recognize(url)
    return (data.text || '').trim()
  } catch (e) {
    console.warn('OCR failed:', e)
    return ''
  }
}

/** Free the worker (and its wasm) — call when OCR is done for a while. */
export async function disposeOcr(): Promise<void> {
  if (_worker) {
    try {
      await _worker.terminate()
    } catch {
      /* ignore */
    }
    _worker = null
    _loading = null
  }
}

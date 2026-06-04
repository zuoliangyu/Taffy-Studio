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
import type { McpServerConfig, McpTool } from '../lib/mcp'
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

export function mcpConnect(_config: McpServerConfig): Promise<McpTool[]> {
  return notImpl('mcpConnect')
}

export function mcpDisconnect(_id: string): Promise<void> {
  return notImpl('mcpDisconnect')
}

export function mcpListTools(): Promise<McpTool[]> {
  return notImpl('mcpListTools')
}

export function mcpCallTool(
  _serverId: string,
  _name: string,
  _args: unknown,
): Promise<string> {
  return notImpl('mcpCallTool')
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

// ---------- SQLite ----------

export function dbInit(): Promise<void> {
  return notImpl('dbInit')
}

export function dbSelect<T>(_sql: string, _params?: unknown[]): Promise<T> {
  return notImpl('dbSelect')
}

export function dbExecute(_sql: string, _params?: unknown[]): Promise<DbExecResult> {
  return notImpl('dbExecute')
}

// ---------- KV store ----------

export function kvGet<T>(_key: string): Promise<T | null> {
  return notImpl('kvGet')
}

export function kvSet<T>(_key: string, _value: T): Promise<void> {
  return notImpl('kvSet')
}

export function kvDelete(_key: string): Promise<void> {
  return notImpl('kvDelete')
}

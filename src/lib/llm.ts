// LLM provider contract — the Rust side does the actual HTTP work so we get
// streaming + a place to hide API keys.
//
// Streaming uses tauri::ipc::Channel under the hood: typed, single-consumer,
// no global event bus. The Rust side also keeps a cancellation registry
// keyed by `streamId`, so we can interrupt an in-flight stream by id.
import { Channel, invoke } from '@tauri-apps/api/core'
import { ping as pingCmd } from './ipc'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Attachment {
  id: string
  /** 'image' is sent inline to vision models; 'file' carries extracted `text`
   *  that gets spliced into the prompt instead (PDF / txt / md / OCR output). */
  type: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** Base64-encoded payload, no data: URL prefix. */
  data: string
  /** Extracted plain text for non-image documents (PDF/txt/md), or OCR output
   *  for images. Spliced into the message content at send time so providers
   *  that can't ingest the raw file still see its contents. */
  text?: string
}

export interface ChatMessage {
  role: Role
  content: string
  attachments?: Attachment[]
}

export interface ChatRequest {
  /** "openai" | "anthropic" | "gemini" | "deepseek" | "siliconflow" | "ollama" | "custom" */
  provider: string
  /** Endpoint root. If omitted, Rust falls back to a provider-appropriate default. */
  baseUrl?: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  /** Required by Anthropic; useful default elsewhere. */
  maxTokens?: number
  /** Caller-supplied so they can cancel by id. Generated automatically if omitted. */
  streamId?: string
  /** MCP-backed tools the model may call this turn. When present + non-empty
   *  on OpenAI/Anthropic, Rust runs the agentic tool-use loop. */
  tools?: ToolSpec[]
}

export interface ChatResponse {
  content: string
  model: string
}

export interface ToolSpec {
  serverId: string
  name: string
  description: string
  inputSchema: unknown
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'done'; content: string; model: string }
  | { type: 'cancelled'; content: string }
  | { type: 'error'; message: string }
  | { type: 'toolCall'; id: string; serverId: string; name: string; args: string }
  | { type: 'toolResult'; id: string; name: string; result: string }

/** Quick liveness check of the Rust side. */
export function ping(payload: string): Promise<string> {
  return pingCmd(payload)
}

/** Non-streaming completion. */
export function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  return invoke<ChatResponse>('chat_complete', { req })
}

/** Fetch the model list for a provider. Anthropic returns a curated fallback
 *  when its model endpoint is unreachable / not enabled. */
export function listModels(req: ChatRequest): Promise<string[]> {
  return invoke<string[]>('list_models', { req })
}

/** Handle returned by chatStream so the caller can abort. */
export interface StreamHandle {
  /** The id the Rust side knows this stream by. */
  id: string
  /** Resolves when the stream ends (done | cancelled | error). */
  promise: Promise<void>
  /** Ask Rust to flip the cancellation flag for this stream. */
  cancel(): Promise<void>
}

/**
 * Start a streaming completion. The returned `promise` resolves when the
 * stream ends — either with `done`, `cancelled`, or `error` (the callback
 * fires once for each).
 */
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

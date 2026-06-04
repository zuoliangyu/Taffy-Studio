// LLM provider contract — the backend does the actual HTTP work so we get
// streaming + a place to hide API keys.
//
// This module owns the wire types; the transport lives in the backend driver
// (`services/{tauriApi,webApi}.ts`). On the Tauri shell streaming rides a
// typed `tauri::ipc::Channel`; on the web shell it will ride SSE. Either way
// the cancellation registry is keyed by `streamId`.
import { api } from '../services/api'

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
  /** Skill names enabled this turn. When non-empty (on OpenAI/Anthropic), Rust
   *  adds the built-in `use_skill` tool + a progressive-disclosure system block.
   *  Also triggers the agentic loop even without MCP tools. */
  enabledSkills?: string[]
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

/** Quick liveness check of the backend. */
export function ping(payload: string): Promise<string> {
  return api.ping(payload)
}

/** Non-streaming completion. */
export function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  return api.chatComplete(req)
}

/** Fetch the model list for a provider. Anthropic returns a curated fallback
 *  when its model endpoint is unreachable / not enabled. */
export function listModels(req: ChatRequest): Promise<string[]> {
  return api.listModels(req)
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
  return api.chatStream(req, onEvent)
}

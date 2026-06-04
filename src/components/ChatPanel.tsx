import { useCallback, useEffect, useRef, useState } from 'react'
import {
  appendMessage,
  deleteMessage,
  listMessages,
  updateConversationMaxTokens,
  updateConversationModel,
  updateConversationSystemPrompt,
  updateConversationTemperature,
  type Conversation,
  type Message as DbMessage,
} from '../lib/db'
import { getModelCapabilities } from '../lib/capabilities'
import { chatStream, type Attachment, type ChatMessage, type StreamHandle } from '../lib/llm'
import { fileToAttachment } from '../lib/attachments'
import { attachmentTextBlock } from '../lib/doctext'
import { ocrImage } from '../lib/ocr'
import { getConvoPrefs, setConvoPrefs } from '../lib/convoPrefs'
import { mcpListTools, toolsToSpecs, type McpTool } from '../lib/mcp'
import {
  buildContextBlock,
  listKnowledgeBases,
  searchKnowledge,
  type KnowledgeBase,
} from '../lib/rag'
import { useI18n } from '../i18n'
import { getProvider, loadSettings, resolveTarget, type AppSettings } from '../lib/settings'
import { isDefaultTitle, summarizeAndSave } from '../lib/summarize'
import { AttachmentChips } from './AttachmentChips'
import { MessageContent } from './MessageContent'
import { ModelList, ModelPicker, type ModelListHandle } from './ModelPicker'

/** Fold any extracted document / OCR text from attachments into the message
 *  content so providers that can't ingest the raw file still see it. */
function foldAttachmentText(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) => {
    const block = attachmentTextBlock(m.attachments)
    if (!block) return m
    return { ...m, content: m.content ? `${m.content}\n\n${block}` : block }
  })
}

/** One tool invocation surfaced during an agentic stream. */
interface ToolActivity {
  id: string
  name: string
  args: string
  result?: string
}

interface Props {
  conversation: Conversation | null
  /** Notify parent when we patch the title in the DB so the sidebar refreshes. */
  onTitleChanged?: (id: string, title: string) => void
  /** Notify parent when the active conversation's model selection changes. */
  onModelChanged?: (id: string, providerId: string | null, model: string | null) => void
  /** Notify parent when the per-conversation temperature changes. */
  onTemperatureChanged?: (id: string, temperature: number | null) => void
  /** Notify parent when the per-conversation max output tokens changes. */
  onMaxTokensChanged?: (id: string, maxTokens: number | null) => void
  /** Notify parent when the per-conversation system prompt changes. */
  onSystemPromptChanged?: (id: string, systemPrompt: string | null) => void
}

export function ChatPanel({
  conversation,
  onTitleChanged,
  onModelChanged,
  onTemperatureChanged,
  onMaxTokensChanged,
  onSystemPromptChanged,
}: Props) {
  const { t } = useI18n()
  const conversationId = conversation?.id ?? null
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    loadSettings().then(setSettings).catch(console.error)
  }, [])
  const [messages, setMessages] = useState<DbMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  // --- tools + knowledge (per-conversation) ---
  const [toolsEnabled, setToolsEnabled] = useState(false)
  const [kbId, setKbId] = useState<string | null>(null)
  const [connectedTools, setConnectedTools] = useState<McpTool[]>([])
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  // Tool activity for the in-flight stream, rendered as chips above the draft.
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([])
  const [ocrBusyId, setOcrBusyId] = useState<string | null>(null)
  const [retrieving, setRetrieving] = useState(false)
  // The assistant message we're currently filling token-by-token.
  // Kept out of `messages` until it's committed to the DB.
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Attachments staged on the composer, sent with the next message.
  const [pending, setPending] = useState<Attachment[]>([])
  const [draggingOver, setDraggingOver] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Active stream handle — non-null exactly when `streaming` is true.
  const streamRef = useRef<StreamHandle | null>(null)

  // ---- @-mention state ----
  // When the user types '@', we open a popover anchored at the textarea.
  // mentionStart is the index of the '@' character we're tracking.
  // mentionQuery is the text typed between '@' and the caret (used to filter).
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const mentionListRef = useRef<ModelListHandle | null>(null)

  function closeMention() {
    setMentionStart(null)
    setMentionQuery('')
  }

  /** Strip "@<query>" from the textarea at mentionStart and replace with ''. */
  function eatMention(): string {
    if (mentionStart === null) return input
    const before = input.slice(0, mentionStart)
    // Find where the mention token ends (whitespace or end-of-string).
    let end = mentionStart + 1
    while (end < input.length && !/\s/.test(input[end]!)) end++
    const after = input.slice(end)
    // Trim a single trailing space so we don't leave double-spaces.
    const joined = before + after.replace(/^ /, '')
    return joined
  }

  async function ingestFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    for (const f of arr) {
      try {
        const a = await fileToAttachment(f)
        // De-dupe: skip if a pending attachment already matches name+size+mime.
        // Cheap enough vs comparing base64 payloads; collisions are unlikely.
        setPending((p) =>
          p.some(
            (x) => x.name === a.name && x.size === a.size && x.mime === a.mime,
          )
            ? p
            : [...p, a],
        )
      } catch (e) {
        setError(String(e))
      }
    }
  }

  function removeAttachment(id: string) {
    setPending((p) => p.filter((a) => a.id !== id))
  }

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      return
    }
    listMessages(conversationId).then(setMessages).catch(console.error)
  }, [conversationId])

  // Load per-conversation tool/KB prefs + the available KB list whenever we
  // switch conversations. Connected MCP tools are global, refreshed here too.
  useEffect(() => {
    setToolActivity([])
    if (!conversationId) {
      setToolsEnabled(false)
      setKbId(null)
      return
    }
    getConvoPrefs(conversationId)
      .then((p) => {
        setToolsEnabled(!!p.toolsEnabled)
        setKbId(p.kbId ?? null)
      })
      .catch(console.error)
    listKnowledgeBases().then(setKbs).catch(console.error)
    mcpListTools().then(setConnectedTools).catch(() => setConnectedTools([]))
  }, [conversationId])

  function toggleTools() {
    if (!conversationId) return
    const next = !toolsEnabled
    setToolsEnabled(next)
    void setConvoPrefs(conversationId, { toolsEnabled: next })
    if (next) mcpListTools().then(setConnectedTools).catch(() => {})
  }

  function pickKb(id: string | null) {
    if (!conversationId) return
    setKbId(id)
    void setConvoPrefs(conversationId, { kbId: id })
  }

  // Run OCR over a staged image and fold the text into the attachment so it
  // reaches the model even on a non-vision target.
  async function runOcr(att: Attachment) {
    setOcrBusyId(att.id)
    try {
      const text = await ocrImage(att)
      if (text) {
        setPending((p) => p.map((a) => (a.id === att.id ? { ...a, text } : a)))
      }
    } finally {
      setOcrBusyId(null)
    }
  }

  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages, draft])

  // Run a stream using the given history. Caller is responsible for inserting
  // the user message into the DB first (if any). Returns the committed
  // assistant DbMessage, or null if cancelled with no text.
  const runStream = useCallback(
    async (history: ChatMessage[]): Promise<DbMessage | null> => {
      if (!conversationId) return null
      const fresh = await loadSettings()
      setSettings(fresh)
      // Per-conversation override beats the global default.
      const target = await resolveTarget(
        fresh,
        conversation?.provider_id ?? undefined,
        conversation?.model ?? undefined,
        conversation?.temperature ?? undefined,
      )
      if (!target) {
        setError('No provider configured. Open Settings to add one.')
        return null
      }
      if (!target.apiKey) {
        setError('Set an API key in Settings first.')
        return null
      }

      setStreaming(true)
      setDraft('')
      setError(null)
      setToolActivity([])
      let acc = ''
      let cancelled = false

      // Fold any document / OCR text from attachments into message content so
      // non-vision / non-file-upload providers still see it.
      const folded = foldAttachmentText(history)

      // Build the leading system messages: the conversation's system prompt,
      // then (optionally) a retrieved-context block from the attached KB.
      const sys = conversation?.system_prompt?.trim() ?? ''
      const leading: ChatMessage[] = []
      if (sys.length > 0) leading.push({ role: 'system', content: sys })

      const kb = kbId ? kbs.find((k) => k.id === kbId) ?? null : null
      if (kb && kb.embed_model) {
        // Retrieve against the latest user turn.
        const lastUser = [...folded].reverse().find((m) => m.role === 'user')
        const query = lastUser?.content?.trim()
        if (query) {
          setRetrieving(true)
          try {
            const hits = await searchKnowledge(fresh, kb, query, 5)
            const block = buildContextBlock(hits)
            if (block) leading.push({ role: 'system', content: block })
          } catch (e) {
            console.warn('RAG retrieval failed:', e)
          } finally {
            setRetrieving(false)
          }
        }
      }

      const wireHistory: ChatMessage[] = [...leading, ...folded]
      const maxTokensOverride = conversation?.max_tokens ?? null

      // Attach MCP tools only when enabled, present, and the provider supports
      // the agentic loop (Gemini falls back to a plain stream in Rust).
      const useTools =
        toolsEnabled &&
        connectedTools.length > 0 &&
        target.provider !== 'gemini'
      const toolSpecs = useTools ? toolsToSpecs(connectedTools) : undefined

      try {
        const handle = chatStream(
          {
            provider: target.provider,
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            model: target.model,
            temperature: target.temperature,
            messages: wireHistory,
            ...(maxTokensOverride && maxTokensOverride > 0
              ? { maxTokens: maxTokensOverride }
              : {}),
            ...(toolSpecs ? { tools: toolSpecs } : {}),
          },
          (e) => {
            if (e.type === 'token') {
              acc += e.content
              setDraft(acc)
            } else if (e.type === 'done') {
              acc = e.content || acc
            } else if (e.type === 'cancelled') {
              cancelled = true
              acc = e.content || acc
            } else if (e.type === 'error') {
              setError(e.message)
            } else if (e.type === 'toolCall') {
              setToolActivity((list) => [
                ...list,
                { id: e.id, name: e.name, args: e.args },
              ])
            } else if (e.type === 'toolResult') {
              setToolActivity((list) =>
                list.map((a) => (a.id === e.id ? { ...a, result: e.result } : a)),
              )
            }
          },
        )
        streamRef.current = handle
        await handle.promise
      } catch (e) {
        setError(String(e))
      } finally {
        streamRef.current = null
        setStreaming(false)
        setDraft('')
      }

      if (acc) {
        let saved: DbMessage
        try {
          saved = await appendMessage(conversationId, 'assistant', acc)
        } catch (e) {
          console.error('failed to persist assistant message:', e)
          setError(`Could not save assistant reply: ${e}`)
          return null
        }
        setMessages((m) => [...m, saved])

        // First exchange complete? Trigger background title summarization
        // (fire-and-forget; never blocks the user). Only touch the default
        // "Conversation N" placeholder — never overwrite a user-edited title.
        const isFirstExchange =
          // history we sent included exactly one user message + no assistant.
          history.length === 1 && history[0]?.role === 'user'
        if (
          isFirstExchange &&
          conversation?.title &&
          isDefaultTitle(conversation.title)
        ) {
          summarizeAndSave(
            conversationId,
            history[0]!.content,
            acc,
            conversation.provider_id ?? undefined,
            conversation.model ?? undefined,
          ).then((t) => {
            if (t && onTitleChanged) onTitleChanged(conversationId, t)
          })
        }
        return saved
      }
      // Cancelled with no output yet: nothing to commit.
      if (cancelled) return null
      return null
    },
    [conversationId, conversation, onTitleChanged, kbId, kbs, toolsEnabled, connectedTools],
  )

  const onSend = useCallback(async () => {
    if (!conversationId || streaming) return
    const text = input.trim()
    // Allow sending with attachments and no text, but require *something*.
    if (!text && pending.length === 0) return

    // Snapshot pending state before clearing so we can restore on failure.
    const atts = pending
    const inputBackup = input
    setInput('')
    setPending([])

    try {
      const userMsg = await appendMessage(
        conversationId,
        'user',
        text,
        atts.length > 0 ? atts : undefined,
      )
      setMessages((m) => [...m, userMsg])
      const history: ChatMessage[] = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
      }))
      await runStream(history)
    } catch (e) {
      // Most common failure modes here:
      //  1. DB insert fails because migration v2 (attachments column) hasn't
      //     been applied — the dev process needs a cargo rebuild.
      //  2. invoke() payload too large (huge image) — Tauri's IPC bridge
      //     surfaces this as a generic error.
      //  3. Provider returned 4xx on the SSE request (wrong vision-capable
      //     model, malformed base64, etc.).
      console.error('onSend failed:', e)
      setError(
        String(e) +
          '\n\nIf you just added attachment support, restart `pnpm tauri dev` so the new DB migration runs.',
      )
      // Restore the input and attachments so the user can retry / edit.
      setInput(inputBackup)
      setPending(atts)
    }
  }, [conversationId, input, messages, pending, runStream, streaming])

  const onStop = useCallback(async () => {
    await streamRef.current?.cancel()
  }, [])

  const onRegenerate = useCallback(async () => {
    if (!conversationId || streaming || messages.length === 0) return
    // Find the last assistant message and drop it. If the conversation ends
    // with a user message (no assistant reply yet), just re-stream from it.
    const last = messages[messages.length - 1]!
    let baseMessages = messages
    if (last.role === 'assistant') {
      await deleteMessage(last.id)
      baseMessages = messages.slice(0, -1)
      setMessages(baseMessages)
    }
    const history: ChatMessage[] = baseMessages.map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments,
    }))
    if (history.length === 0) return
    await runStream(history)
  }, [conversationId, messages, runStream, streaming])

  async function onPickModel(providerId: string, model: string) {
    if (!conversationId) return
    await updateConversationModel(conversationId, providerId, model)
    onModelChanged?.(conversationId, providerId, model)
  }

  async function onChangeTemperature(t: number | null) {
    if (!conversationId) return
    await updateConversationTemperature(conversationId, t)
    onTemperatureChanged?.(conversationId, t)
  }

  async function onChangeMaxTokens(n: number | null) {
    if (!conversationId) return
    await updateConversationMaxTokens(conversationId, n)
    onMaxTokensChanged?.(conversationId, n)
  }

  async function onChangeSystemPrompt(s: string | null) {
    if (!conversationId) return
    const next = s && s.trim().length > 0 ? s : null
    await updateConversationSystemPrompt(conversationId, next)
    onSystemPromptChanged?.(conversationId, next)
  }

  if (!conversationId) {
    return (
      <div className="empty">
        <p>{t('chat.emptyPick')}</p>
      </div>
    )
  }

  // Effective provider+model used by THIS conversation (override > default).
  const effectiveProvider =
    settings && (getProvider(settings, conversation?.provider_id ?? undefined) ?? getProvider(settings))
  const effectiveModel =
    conversation?.model || effectiveProvider?.defaultModel || ''
  // Capability lookup is cheap (one regex per call); compute on render.
  const effectiveCaps = effectiveProvider
    ? getModelCapabilities(effectiveProvider, effectiveModel)
    : null
  // Only image/* attachments are sent to the LLM — non-image attachments
  // don't trigger the vision warning regardless of model.
  const hasPendingImage = pending.some((a) => a.type === 'image')
  const visionWarning =
    hasPendingImage && effectiveCaps !== null && !effectiveCaps.vision

  const canRegenerate =
    !streaming && messages.length > 0 && messages.some((m) => m.role === 'user')

  return (
    <div
      className={`chat ${draggingOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDraggingOver(true)
        }
      }}
      onDragLeave={() => setDraggingOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          setDraggingOver(false)
          ingestFiles(e.dataTransfer.files)
        }
      }}
    >
      {settings && effectiveProvider && (
        <div className="chat-header-row">
          <ModelPicker
            settings={settings}
            providerId={effectiveProvider.id}
            model={effectiveModel}
            onPick={onPickModel}
          />
          <TemperatureChip
            value={conversation?.temperature ?? null}
            fallback={settings.temperature}
            onChange={onChangeTemperature}
          />
          <OverridesChip
            maxTokens={conversation?.max_tokens ?? null}
            systemPrompt={conversation?.system_prompt ?? null}
            onChangeMaxTokens={onChangeMaxTokens}
            onChangeSystemPrompt={onChangeSystemPrompt}
          />
          <button
            type="button"
            className={`model-chip tools-chip ${toolsEnabled ? 'override' : ''}`}
            onClick={toggleTools}
            title={toolsEnabled ? t('chat.toolsOn') : t('chat.toolsOff')}
          >
            <span className="label">🛠 {t('chat.tools')}</span>
            {toolsEnabled && connectedTools.length > 0 && (
              <span className="chip-count">{connectedTools.length}</span>
            )}
          </button>
          <KbChip kbs={kbs} value={kbId} onPick={pickKb} />
        </div>
      )}
      <div className="messages" ref={scrollerRef}>
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} content={m.content} attachments={m.attachments} />
        ))}
        {(retrieving || toolActivity.length > 0) && (
          <div className="agent-activity">
            {retrieving && (
              <div className="agent-line retrieving">
                <span className="spinner" aria-hidden="true" />
                {t('chat.kbRetrieving')}
              </div>
            )}
            {toolActivity.map((a) => (
              <div key={a.id} className={`tool-pill ${a.result !== undefined ? 'done' : 'running'}`}>
                <span className="tool-pill-icon" aria-hidden="true">
                  {a.result !== undefined ? '✓' : <span className="spinner" />}
                </span>
                <code className="tool-pill-name">{a.name}</code>
                {a.result !== undefined && a.result.startsWith('ERROR') && (
                  <span className="tool-pill-err">!</span>
                )}
              </div>
            ))}
          </div>
        )}
        {streaming && <Bubble role="assistant" content={draft} pending />}
        {error && <div className="error">⚠ {error}</div>}
        {canRegenerate && (
          <div className="regen-row">
            <button type="button" className="ghost small" onClick={onRegenerate} title={t('chat.regenerateHint')}>
              {t('chat.regenerate')}
            </button>
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          onSend()
        }}
      >
        {mentionStart !== null && settings && (
          <div className="mention-popover">
            <ModelList
              settings={settings}
              currentProviderId={effectiveProvider?.id}
              currentModel={effectiveModel}
              filter={mentionQuery}
              requireVision={hasPendingImage}
              forwardRef={mentionListRef}
              onPick={(pid, m) => {
                // Apply the model + strip the "@xxx" we tracked.
                const newText = eatMention()
                setInput(newText)
                closeMention()
                void onPickModel(pid, m)
                // Restore caret to where the mention used to start.
                setTimeout(() => {
                  const ta = textareaRef.current
                  if (ta) {
                    const pos = Math.min(newText.length, mentionStart ?? 0)
                    ta.focus()
                    ta.setSelectionRange(pos, pos)
                  }
                }, 0)
              }}
            />
          </div>
        )}
        {visionWarning && (
          <div className="vision-warning" role="alert">
            <span className="vw-icon" aria-hidden="true">⚠</span>
            <span className="vw-text">
              <strong>{effectiveModel || 'This model'}</strong> {t('chat.visionWarning')}
            </span>
            <button
              type="button"
              className="ghost small vw-ocr"
              disabled={ocrBusyId !== null}
              onClick={async () => {
                for (const a of pending.filter((p) => p.type === 'image' && !p.text)) {
                  await runOcr(a)
                }
              }}
            >
              {ocrBusyId !== null ? t('chat.ocrRunning') : t('chat.runOcr')}
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="composer-attachments">
            <AttachmentChips items={pending} onRemove={removeAttachment} variant="composer" />
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="ghost icon attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title={t('chat.attachImage')}
            aria-label={t('chat.attachImage')}
            disabled={streaming}
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.markdown,.csv,.json,.html,.xml,.log"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) ingestFiles(e.target.files)
              e.target.value = '' // allow re-selecting the same file
            }}
          />
          <textarea
            ref={textareaRef}
            placeholder={
              streaming
                ? t('chat.streaming')
                : pending.length > 0
                  ? t('chat.attachNote')
                  : t('chat.placeholder')
            }
            value={input}
            onChange={(e) => {
              const v = e.target.value
              setInput(v)
              // Track @-mention: if cursor is right after '@' or any non-space
              // run starting with '@', surface a model popover.
              const caret = e.target.selectionStart ?? v.length
              const at = v.lastIndexOf('@', Math.max(0, caret - 1))
              if (at >= 0) {
                // The token ends at the caret OR at the next whitespace.
                const between = v.slice(at + 1, caret)
                // If the user typed a space, dismiss the popover.
                if (between.includes(' ') || between.includes('\n')) {
                  closeMention()
                } else {
                  setMentionStart(at)
                  setMentionQuery(between)
                }
              } else {
                closeMention()
              }
            }}
            onKeyDown={(e) => {
              // Arrow/Enter/Escape are intercepted while the mention popover
              // is open so the user can navigate it without losing focus.
              if (mentionStart !== null) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  mentionListRef.current?.step(1)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  mentionListRef.current?.step(-1)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  mentionListRef.current?.pickCurrent()
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeMention()
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (streaming) onStop()
                else onSend()
              }
            }}
            onPaste={(e) => {
              // Pull any image/* items from the clipboard. Text paste keeps
              // its default behavior.
              const files: File[] = []
              for (const it of Array.from(e.clipboardData.items)) {
                if (it.kind === 'file') {
                  const f = it.getAsFile()
                  if (f && f.type.startsWith('image/')) files.push(f)
                }
              }
              if (files.length > 0) {
                e.preventDefault()
                ingestFiles(files)
              }
            }}
            rows={2}
          />
          {streaming ? (
            <button type="button" onClick={onStop} className="stop">
              {t('chat.stop')}
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() && pending.length === 0}>
              {t('chat.send')}
            </button>
          )}
        </div>
      </form>
      {draggingOver && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-hint">{t('chat.dropToAttach')}</div>
        </div>
      )}
    </div>
  )
}

function Bubble({
  role,
  content,
  attachments,
  pending,
}: {
  role: string
  content: string
  attachments?: Attachment[]
  pending?: boolean
}) {
  const asPlain = role === 'user'
  const [previewing, setPreviewing] = useState<Attachment | null>(null)
  return (
    <div className={`bubble bubble-${role} ${pending ? 'pending' : ''}`}>
      <div className="bubble-role">{role}</div>
      {attachments && attachments.length > 0 && (
        <AttachmentChips
          items={attachments}
          onRemove={() => {}}
          variant="bubble"
          onPreview={(a) => setPreviewing(a)}
        />
      )}
      {(content || pending) && (
        <div className="bubble-content">
          {content
            ? <MessageContent content={content} plain={asPlain} streaming={pending} />
            : pending && <span className="md-cursor">▍</span>}
        </div>
      )}
      {previewing && (
        <ImagePreview attachment={previewing} onClose={() => setPreviewing(null)} />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// TemperatureChip — chip in the chat header that pops a slider for the
// per-conversation temperature. Falls back to the global default when unset.
// -----------------------------------------------------------------------------

function TemperatureChip({
  value,
  fallback,
  onChange,
}: {
  value: number | null
  fallback: number
  onChange: (t: number | null) => Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const effective = value ?? fallback
  const isOverride = value !== null

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="temp-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`model-chip temp-chip ${isOverride ? 'override' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={
          isOverride
            ? t('temp.titleOverride', {
                v: effective.toFixed(1),
                d: fallback.toFixed(1),
              })
            : t('temp.titleDefault', { v: effective.toFixed(1) })
        }
      >
        <span className="label">T {effective.toFixed(1)}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="temp-popover">
          <div className="temp-popover-head">
            Temperature for this conversation
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={effective}
            onChange={(e) => void onChange(parseFloat(e.target.value))}
          />
          <div className="temp-popover-foot">
            <span className="muted-small">
              {isOverride ? 'overriding default' : `default: ${fallback.toFixed(1)}`}
            </span>
            {isOverride && (
              <button
                type="button"
                className="ghost small"
                onClick={() => void onChange(null)}
                title="Use the global default temperature"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// OverridesChip — chat-header ⚙ popover that gathers the per-conversation
// overrides that don't deserve their own chip. Today: max output tokens +
// system prompt. Both default to "unset" (NULL in DB), and the chip surface
// flips a dot ON when at least one override is active.
// -----------------------------------------------------------------------------

function OverridesChip({
  maxTokens,
  systemPrompt,
  onChangeMaxTokens,
  onChangeSystemPrompt,
}: {
  maxTokens: number | null
  systemPrompt: string | null
  onChangeMaxTokens: (n: number | null) => Promise<void>
  onChangeSystemPrompt: (s: string | null) => Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Local draft for max_tokens so we don't write the DB on every keystroke;
  // commit on blur / Enter. Local text for system prompt is the same idea.
  const [mtDraft, setMtDraft] = useState<string>(maxTokens != null ? String(maxTokens) : '')
  const [spDraft, setSpDraft] = useState<string>(systemPrompt ?? '')

  useEffect(() => {
    setMtDraft(maxTokens != null ? String(maxTokens) : '')
  }, [maxTokens])
  useEffect(() => {
    setSpDraft(systemPrompt ?? '')
  }, [systemPrompt])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const hasOverride =
    (typeof maxTokens === 'number' && maxTokens > 0) ||
    (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0)

  function commitMaxTokens() {
    const trimmed = mtDraft.trim()
    if (trimmed.length === 0) {
      if (maxTokens !== null) void onChangeMaxTokens(null)
      return
    }
    // Plain positive integer; reject anything else.
    const n = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(n) || n <= 0) {
      // Revert local draft to whatever's persisted.
      setMtDraft(maxTokens != null ? String(maxTokens) : '')
      return
    }
    if (n !== maxTokens) void onChangeMaxTokens(n)
  }

  function commitSystemPrompt() {
    const trimmed = spDraft.trim()
    const persisted = systemPrompt ?? ''
    if (trimmed === persisted.trim()) return
    void onChangeSystemPrompt(trimmed.length > 0 ? trimmed : null)
  }

  return (
    <div className="overrides-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`model-chip overrides-chip ${hasOverride ? 'override' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={
          hasOverride ? t('overrides.titleActive') : t('overrides.titleNone')
        }
      >
        <span className="label">⚙</span>
        {hasOverride && <span className="override-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="overrides-popover">
          <div className="overrides-popover-head">Conversation overrides</div>

          <label className="overrides-row">
            <span className="overrides-label">Max output tokens</span>
            <span className="overrides-input-wrap">
              <input
                type="number"
                min={1}
                step={1}
                placeholder="default"
                value={mtDraft}
                onChange={(e) => setMtDraft(e.target.value)}
                onBlur={commitMaxTokens}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitMaxTokens()
                  } else if (e.key === 'Escape') {
                    setMtDraft(maxTokens != null ? String(maxTokens) : '')
                  }
                }}
              />
              {maxTokens != null && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setMtDraft('')
                    void onChangeMaxTokens(null)
                  }}
                  title="Use provider default"
                >
                  Reset
                </button>
              )}
            </span>
          </label>

          <div className="overrides-row column">
            <span className="overrides-label">System prompt</span>
            <textarea
              className="overrides-textarea"
              placeholder="(none — uses the model's defaults)"
              value={spDraft}
              onChange={(e) => setSpDraft(e.target.value)}
              onBlur={commitSystemPrompt}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSpDraft(systemPrompt ?? '')
                }
              }}
              rows={4}
            />
            <div className="overrides-row-foot">
              <span className="muted-small">
                Prepended to every request; not stored as a message.
              </span>
              {systemPrompt && systemPrompt.length > 0 && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setSpDraft('')
                    void onChangeSystemPrompt(null)
                  }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// KbChip — chat-header chip that picks which knowledge base (if any) augments
// this conversation's retrieval. Mirrors the TemperatureChip popover idiom.
// -----------------------------------------------------------------------------

function KbChip({
  kbs,
  value,
  onPick,
}: {
  kbs: KnowledgeBase[]
  value: string | null
  onPick: (id: string | null) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const active = value ? kbs.find((k) => k.id === value) ?? null : null

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // No KBs configured yet → render nothing (keeps the header tidy).
  if (kbs.length === 0) return null

  return (
    <div className="kb-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`model-chip kb-chip ${active ? 'override' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={active ? active.name : t('chat.kbNone')}
      >
        <span className="label">📚 {active ? active.name : t('chat.kb')}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="kb-chip-popover">
          <button
            type="button"
            className={`kb-chip-item ${!value ? 'active' : ''}`}
            onClick={() => {
              onPick(null)
              setOpen(false)
            }}
          >
            {t('chat.kbNone')}
          </button>
          {kbs.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`kb-chip-item ${value === k.id ? 'active' : ''}`}
              onClick={() => {
                onPick(k.id)
                setOpen(false)
              }}
            >
              {k.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImagePreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  // Reuse the modal-backdrop styling for visual consistency.
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <img
        className="image-preview"
        src={`data:${attachment.mime};base64,${attachment.data}`}
        alt={attachment.name}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

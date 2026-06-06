import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { listSkills, type SkillMeta } from '../lib/skills'
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
import { Icon } from './Icon'
import logoUrl from '../assets/logo.png'

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

/** A provider+model pair used to target a request. */
interface ModelRef {
  providerId: string
  model: string
}

/** A live per-model draft column during a multi-model fan-out. */
interface MultiSlot extends ModelRef {
  text: string
  error?: string
  /** True once this model's stream has finished (stops the blinking cursor). */
  done?: boolean
  /** Wall-clock generation time in ms, set when the stream finishes. */
  elapsedMs?: number
}

/** Dedupe a list of model refs by providerId+model, preserving order. */
function dedupeRefs(refs: ModelRef[]): ModelRef[] {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = `${r.providerId}::${r.model}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
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
  // --- tools + knowledge + skills (per-conversation) ---
  const [toolsEnabled, setToolsEnabled] = useState(false)
  const [kbId, setKbId] = useState<string | null>(null)
  const [connectedTools, setConnectedTools] = useState<McpTool[]>([])
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [allSkills, setAllSkills] = useState<SkillMeta[]>([])
  const [enabledSkills, setEnabledSkills] = useState<string[]>([])
  // Tool activity for the in-flight stream, rendered as chips above the draft.
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([])
  const [ocrBusyId, setOcrBusyId] = useState<string | null>(null)
  const [retrieving, setRetrieving] = useState(false)
  // The assistant message we're currently filling token-by-token.
  // Kept out of `messages` until it's committed to the DB.
  const [draft, setDraft] = useState('')
  // --- multi-model fan-out (Cherry-style) ---
  // Extra models the next send fans out to (beyond the conversation's primary).
  const [compareModels, setCompareModels] = useState<ModelRef[]>([])
  // In-flight per-model drafts, rendered as side-by-side columns while streaming.
  const [multiDrafts, setMultiDrafts] = useState<MultiSlot[]>([])
  // Handles for every concurrent stream, so Stop cancels them all.
  const streamRefsRef = useRef<StreamHandle[]>([])
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
    // Reset the per-turn comparison fan-out when switching conversations.
    setCompareModels([])
    setMultiDrafts([])
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
      setEnabledSkills([])
      return
    }
    getConvoPrefs(conversationId)
      .then((p) => {
        setToolsEnabled(!!p.toolsEnabled)
        setKbId(p.kbId ?? null)
        setEnabledSkills(p.enabledSkills ?? [])
      })
      .catch(console.error)
    listKnowledgeBases().then(setKbs).catch(console.error)
    listSkills().then(setAllSkills).catch(() => setAllSkills([]))
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

  function pickSkills(names: string[]) {
    if (!conversationId) return
    setEnabledSkills(names)
    void setConvoPrefs(conversationId, { enabledSkills: names })
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
      // Skills also drive the agentic loop (even without MCP tools); Gemini
      // tool-use isn't wired, so skip there.
      const skillsForTurn =
        target.provider !== 'gemini' && enabledSkills.length > 0 ? enabledSkills : undefined

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
            ...(skillsForTurn ? { enabledSkills: skillsForTurn } : {}),
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
    [
      conversationId,
      conversation,
      onTitleChanged,
      kbId,
      kbs,
      toolsEnabled,
      connectedTools,
      enabledSkills,
    ],
  )

  // Multi-model fan-out: stream `targets` concurrently from the SAME history,
  // render them as live columns, then commit one assistant message per model
  // (tagged with its model). Tools/skills are intentionally skipped here — this
  // is a raw side-by-side comparison path.
  const runMultiStream = useCallback(
    async (dbHistory: DbMessage[], targets: ModelRef[]) => {
      if (!conversationId) return
      const fresh = await loadSettings()
      setSettings(fresh)

      const resolved = await Promise.all(
        targets.map(async (ref) => {
          const target = await resolveTarget(
            fresh,
            ref.providerId,
            ref.model,
            conversation?.temperature ?? undefined,
          )
          return target ? { ref, target } : null
        }),
      )
      const ok = resolved.filter((x): x is NonNullable<typeof x> => x !== null)
      if (ok.length === 0) {
        setError('No provider configured. Open Settings to add one.')
        return
      }
      const noKey = ok.find((x) => !x.target.apiKey)
      if (noKey) {
        setError(`Set an API key for ${noKey.ref.model} in Settings first.`)
        return
      }

      setStreaming(true)
      setError(null)
      setToolActivity([])

      // Shared leading messages: system prompt + (optional) retrieved KB block.
      const sys = conversation?.system_prompt?.trim() ?? ''
      const leading: ChatMessage[] = []
      if (sys.length > 0) leading.push({ role: 'system', content: sys })
      const kb = kbId ? kbs.find((k) => k.id === kbId) ?? null : null
      if (kb && kb.embed_model) {
        const lastUser = [...dbHistory].reverse().find((m) => m.role === 'user')
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
      const maxTokensOverride = conversation?.max_tokens ?? null

      setMultiDrafts(ok.map(({ ref }) => ({ ...ref, text: '' })))
      const accs = ok.map(() => '')
      streamRefsRef.current = []

      await Promise.all(
        ok.map(({ ref, target }, i) =>
          (async () => {
            // Each model sees its OWN prior replies (or legacy untagged ones).
            const perModel = dbHistory.filter(
              (m) => m.role !== 'assistant' || !m.model || m.model === ref.model,
            )
            const wire = foldAttachmentText(
              perModel.map((m) => ({
                role: m.role,
                content: m.content,
                attachments: m.attachments,
              })),
            )
            const wireMessages: ChatMessage[] = [...leading, ...wire]
            let acc = ''
            const startedAt = Date.now()
            try {
              const handle = chatStream(
                {
                  provider: target.provider,
                  baseUrl: target.baseUrl,
                  apiKey: target.apiKey,
                  model: target.model,
                  temperature: target.temperature,
                  messages: wireMessages,
                  ...(maxTokensOverride && maxTokensOverride > 0
                    ? { maxTokens: maxTokensOverride }
                    : {}),
                },
                (e) => {
                  if (e.type === 'token') {
                    acc += e.content
                    setMultiDrafts((s) =>
                      s.map((x, j) => (j === i ? { ...x, text: acc } : x)),
                    )
                  } else if (e.type === 'done' || e.type === 'cancelled') {
                    acc = e.content || acc
                    const ms = Date.now() - startedAt
                    setMultiDrafts((s) =>
                      s.map((x, j) =>
                        j === i ? { ...x, text: acc, done: true, elapsedMs: ms } : x,
                      ),
                    )
                  } else if (e.type === 'error') {
                    setMultiDrafts((s) =>
                      s.map((x, j) => (j === i ? { ...x, error: e.message, done: true } : x)),
                    )
                  }
                },
              )
              streamRefsRef.current.push(handle)
              await handle.promise
            } catch (e) {
              setMultiDrafts((s) =>
                s.map((x, j) => (j === i ? { ...x, error: String(e), done: true } : x)),
              )
            }
            accs[i] = acc
          })(),
        ),
      )

      streamRefsRef.current = []
      setStreaming(false)
      setMultiDrafts([])

      for (let i = 0; i < ok.length; i++) {
        const content = accs[i]
        const entry = ok[i]
        if (!content || !entry) continue
        try {
          const saved = await appendMessage(
            conversationId,
            'assistant',
            content,
            undefined,
            entry.ref.model,
          )
          setMessages((m) => [...m, saved])
        } catch (e) {
          console.error('failed to persist assistant message:', e)
          setError(`Could not save assistant reply: ${e}`)
        }
      }
    },
    [conversationId, conversation, kbId, kbs],
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
      const dbHistory = [...messages, userMsg]

      // Determine the fan-out targets: the conversation's primary model plus any
      // extra "compare" models. >1 distinct target → multi-model columns.
      const primaryProvider = settings
        ? getProvider(settings, conversation?.provider_id ?? undefined) ??
          getProvider(settings)
        : null
      const primaryRef: ModelRef | null = primaryProvider
        ? {
            providerId: primaryProvider.id,
            model: conversation?.model || primaryProvider.defaultModel || '',
          }
        : null
      const targets = dedupeRefs(
        primaryRef ? [primaryRef, ...compareModels] : compareModels,
      )

      if (targets.length > 1) {
        await runMultiStream(dbHistory, targets)
      } else {
        const history: ChatMessage[] = dbHistory.map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }))
        await runStream(history)
      }
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
  }, [
    conversationId,
    input,
    messages,
    pending,
    runStream,
    runMultiStream,
    compareModels,
    settings,
    conversation,
    streaming,
  ])

  const onStop = useCallback(async () => {
    await streamRef.current?.cancel()
    await Promise.allSettled(streamRefsRef.current.map((h) => h.cancel()))
  }, [])

  // Real edit (matches Cherry/kelivo): drop the user message AND everything
  // after it, then load its text + attachments back into the composer so the
  // user can amend and resend — rather than appending a duplicate.
  const editMessageAt = useCallback(
    async (index: number) => {
      if (streaming) return
      const target = messages[index]
      if (!target || target.role !== 'user') return
      const removed = messages.slice(index)
      setMessages(messages.slice(0, index))
      setInput(target.content)
      if (target.attachments && target.attachments.length > 0) {
        setPending(target.attachments as Attachment[])
      }
      for (const msg of removed) await deleteMessage(msg.id)
      textareaRef.current?.focus()
    },
    [messages, streaming],
  )

  // Delete a single message (and refresh the local list).
  const deleteMessageAt = useCallback(
    async (index: number) => {
      if (streaming) return
      const target = messages[index]
      if (!target) return
      setMessages(messages.filter((x) => x.id !== target.id))
      await deleteMessage(target.id)
    },
    [messages, streaming],
  )

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

  // Best-effort provider lookup for a bare model name (committed messages only
  // store the model, not the provider) — pick the provider that has it enabled,
  // else fall back to the conversation's primary provider.
  const providerRefForModel = useCallback(
    (model: string): ModelRef => {
      const p =
        settings?.providers.find((pr) => pr.enabledModels.includes(model)) ??
        (settings ? getProvider(settings) : null)
      return { providerId: p?.id ?? '', model }
    },
    [settings],
  )

  // Retry a multi-model group (the last fan-out). `onlyModel` retries a single
  // column; omit it to re-run the whole batch. Drops the affected assistant
  // messages, then re-streams from the shared history up to the user turn.
  const retryGroup = useCallback(
    async (start: number, end: number, onlyModel?: string) => {
      if (streaming || !conversationId) return
      const group = messages.slice(start, end)
      const history = messages.slice(0, start)
      const toDelete = onlyModel ? group.filter((m) => m.model === onlyModel) : group
      const models = (onlyModel ? [onlyModel] : group.map((m) => m.model)).filter(
        (m): m is string => !!m,
      )
      if (models.length === 0) return
      const targets = dedupeRefs(models.map((m) => providerRefForModel(m)))
      setMessages(messages.filter((m) => !toDelete.some((d) => d.id === m.id)))
      for (const m of toDelete) await deleteMessage(m.id)
      await runMultiStream(history, targets)
    },
    [conversationId, messages, streaming, providerRefForModel, runMultiStream],
  )

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
      <div className="empty chat-hero">
        <div className="chat-hero-mark">
          <img src={logoUrl} alt="" />
        </div>
        <div className="chat-hero-title">Taffy Studio</div>
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

  // Per-message regenerate lives in the assistant bubble's action bar. The
  // global row only needs to cover the edge case where the conversation ends
  // on a user turn with no assistant reply yet (e.g. a failed/cancelled send).
  const canRegenerate =
    !streaming &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === 'user'

  // Group the message list for rendering: a run of >1 consecutive assistant
  // messages is a multi-model fan-out → render as side-by-side columns; anything
  // else renders as a normal stacked bubble. `start` is the absolute index of
  // the group's first message (used to address edit/delete).
  type RenderGroup =
    | { kind: 'single'; msg: DbMessage; index: number }
    | { kind: 'columns'; msgs: DbMessage[]; start: number }
  const renderGroups = useMemo<RenderGroup[]>(() => {
    const out: RenderGroup[] = []
    let i = 0
    while (i < messages.length) {
      const m = messages[i]!
      if (m.role === 'assistant') {
        let j = i + 1
        while (j < messages.length && messages[j]!.role === 'assistant') j++
        if (j - i > 1) {
          out.push({ kind: 'columns', msgs: messages.slice(i, j), start: i })
          i = j
          continue
        }
      }
      out.push({ kind: 'single', msg: m, index: i })
      i++
    }
    return out
  }, [messages])

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
            <span className="label"><Icon name="wrench" size={14} /> {t('chat.tools')}</span>
            {toolsEnabled && connectedTools.length > 0 && (
              <span className="chip-count">{connectedTools.length}</span>
            )}
          </button>
          <KbChip kbs={kbs} value={kbId} onPick={pickKb} />
          <SkillsChip skills={allSkills} value={enabledSkills} onChange={pickSkills} />
          <CompareChip settings={settings} value={compareModels} onChange={setCompareModels} />
        </div>
      )}
      <div className="messages" ref={scrollerRef}>
        {messages.length === 0 && !streaming && !retrieving && toolActivity.length === 0 && (
          <div className="empty messages-empty">
            <div className="chat-hero-mark sm">
              <img src={logoUrl} alt="" />
            </div>
            <p>{t('chat.emptyConvo')}</p>
            <p className="muted-small">{t('chat.emptyConvoHint')}</p>
          </div>
        )}
        {renderGroups.map((g) =>
          g.kind === 'columns' ? (
            (() => {
              const end = g.start + g.msgs.length
              const isLastGroup = end === messages.length
              return (
                <div className="msg-group" key={g.msgs[0]!.id}>
                  <div className="msg-columns">
                    {g.msgs.map((m, ci) => (
                      <div className="msg-column" key={m.id}>
                        <Bubble
                          role={m.role}
                          content={m.content}
                          attachments={m.attachments}
                          label={m.model ?? undefined}
                          onCopy={() => void navigator.clipboard?.writeText(m.content)}
                          onRegenerate={
                            !streaming && isLastGroup && m.model
                              ? () => void retryGroup(g.start, end, m.model)
                              : undefined
                          }
                          onDelete={
                            !streaming ? () => void deleteMessageAt(g.start + ci) : undefined
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {!streaming && isLastGroup && (
                    <div className="msg-group-foot">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => void retryGroup(g.start, end)}
                        title={t('chat.retryAllHint')}
                      >
                        <Icon name="refresh" size={14} /> {t('chat.retryAll')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })()
          ) : (
            (() => {
              const m = g.msg
              const i = g.index
              const isLastMessage = i === messages.length - 1
              return (
                <Bubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  attachments={m.attachments}
                  onCopy={() => void navigator.clipboard?.writeText(m.content)}
                  onEdit={
                    m.role === 'user' && !streaming
                      ? () => void editMessageAt(i)
                      : undefined
                  }
                  onDelete={!streaming ? () => void deleteMessageAt(i) : undefined}
                  onRegenerate={
                    !streaming && isLastMessage && m.role === 'assistant'
                      ? onRegenerate
                      : undefined
                  }
                />
              )
            })()
          ),
        )}
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
                  {a.result !== undefined ? <Icon name="check" size={13} /> : <span className="spinner" />}
                </span>
                <code className="tool-pill-name">{a.name}</code>
                {a.result !== undefined && a.result.startsWith('ERROR') && (
                  <span className="tool-pill-err">!</span>
                )}
              </div>
            ))}
          </div>
        )}
        {streaming && multiDrafts.length > 0 ? (
          <div className="msg-columns">
            {multiDrafts.map((d, i) => (
              <div className="msg-column" key={`${d.providerId}::${d.model}::${i}`}>
                <Bubble
                  role="assistant"
                  content={d.text}
                  label={
                    d.done && d.elapsedMs !== undefined
                      ? `${d.model} · ${(d.elapsedMs / 1000).toFixed(1)}s`
                      : d.model
                  }
                  pending={!d.done}
                />
                {d.error && (
                  <div className="error">
                    <Icon name="alert" size={15} /> <span>{d.error}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          streaming && <Bubble role="assistant" content={draft} pending />
        )}
        {error && (
          <div className="error">
            <Icon name="alert" size={15} /> <span>{error}</span>
          </div>
        )}
        {canRegenerate && (
          <div className="regen-row">
            <button type="button" className="ghost small" onClick={onRegenerate} title={t('chat.regenerateHint')}>
              <Icon name="refresh" size={14} /> {t('chat.regenerate')}
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
                // Strip the "@xxx" we tracked, then add this model to the
                // comparison fan-out so the next send also goes to it (the
                // responses render side by side).
                const newText = eatMention()
                setInput(newText)
                closeMention()
                setCompareModels((prev) =>
                  prev.some((v) => v.providerId === pid && v.model === m)
                    ? prev
                    : [...prev, { providerId: pid, model: m }],
                )
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
            <span className="vw-icon" aria-hidden="true"><Icon name="alert" size={15} /></span>
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
            <Icon name="paperclip" size={20} />
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
            <button
              type="button"
              onClick={onStop}
              className="send-btn stop"
              title={t('chat.stop')}
              aria-label={t('chat.stop')}
            >
              <Icon name="stop" size={20} filled />
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              disabled={!input.trim() && pending.length === 0}
              title={t('chat.send')}
              aria-label={t('chat.send')}
            >
              <Icon name="send" size={20} />
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

// CompareChip — header multi-select that picks the extra models a send fans out
// to (Cherry-style side-by-side comparison). Empty = single-model as usual.
function CompareChip({
  settings,
  value,
  onChange,
}: {
  settings: AppSettings
  value: ModelRef[]
  onChange: (v: ModelRef[]) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const all = settings.providers.flatMap((p) =>
    p.enabledModels.map((m) => ({ providerId: p.id, model: m, providerName: p.name })),
  )
  const has = (providerId: string, model: string) =>
    value.some((v) => v.providerId === providerId && v.model === model)
  const toggle = (providerId: string, model: string) => {
    if (has(providerId, model)) {
      onChange(value.filter((v) => !(v.providerId === providerId && v.model === model)))
    } else {
      onChange([...value, { providerId, model }])
    }
  }

  return (
    <div className="kb-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`model-chip ${value.length > 0 ? 'override' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={t('chat.compareHint')}
      >
        <span className="label">
          <Icon name="layers" size={14} /> {t('chat.compare')}
          {value.length > 0 ? ` (${value.length})` : ''}
        </span>
        <Icon name="chevron-down" size={13} className="caret" />
      </button>
      {open && (
        <div className="kb-chip-popover">
          {all.length === 0 && <div className="kb-chip-item">{t('chat.compareNone')}</div>}
          {all.map((r) => (
            <button
              type="button"
              key={`${r.providerId}::${r.model}`}
              className={`kb-chip-item ${has(r.providerId, r.model) ? 'active' : ''}`}
              onClick={() => toggle(r.providerId, r.model)}
            >
              {has(r.providerId, r.model) && <Icon name="check" size={14} />}
              {r.model} <span className="muted-small">· {r.providerName}</span>
            </button>
          ))}
          {value.length > 0 && (
            <>
              <div className="convo-menu-sep" />
              <button
                type="button"
                className="kb-chip-item danger"
                onClick={() => onChange([])}
              >
                <Icon name="x" size={14} /> {t('chat.compareClear')}
              </button>
            </>
          )}
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
  label,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  role: string
  content: string
  attachments?: Attachment[]
  pending?: boolean
  /** Overrides the role label (e.g. the model name in a comparison column). */
  label?: string
  /** Copy raw message text. Omitted on the in-flight streaming draft. */
  onCopy?: () => void
  /** User messages only — drop this turn onward and load it back to edit. */
  onEdit?: () => void
  /** Delete this single message. */
  onDelete?: () => void
  /** Last assistant message only — re-run the turn. */
  onRegenerate?: () => void
}) {
  const { t } = useI18n()
  const asPlain = role === 'user'
  const [previewing, setPreviewing] = useState<Attachment | null>(null)
  const [copied, setCopied] = useState(false)
  const roleLabel =
    label ??
    (role === 'user'
      ? t('role.user')
      : role === 'system'
        ? t('role.system')
        : role === 'tool'
          ? t('role.tool')
          : t('role.assistant'))

  function handleCopy() {
    onCopy?.()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  // The action bar is hidden on the streaming draft (no stable message yet)
  // and on empty bubbles. Buttons render only when their handler is supplied.
  const showActions =
    !pending && !!content && (onCopy || onEdit || onDelete || onRegenerate)

  return (
    <div className={`bubble bubble-${role} ${pending ? 'pending' : ''}`}>
      <div className="bubble-role">{roleLabel}</div>
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
      {showActions && (
        <div className="bubble-actions">
          {onCopy && (
            <button
              type="button"
              className="msg-action"
              onClick={handleCopy}
              title={t('chat.copy')}
              aria-label={t('chat.copy')}
            >
              <Icon name={copied ? 'check' : 'copy'} size={15} />
            </button>
          )}
          {onRegenerate && (
            <button
              type="button"
              className="msg-action"
              onClick={onRegenerate}
              title={t('chat.regenerate')}
              aria-label={t('chat.regenerate')}
            >
              <Icon name="refresh" size={15} />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              className="msg-action"
              onClick={onEdit}
              title={t('chat.edit')}
              aria-label={t('chat.edit')}
            >
              <Icon name="pencil" size={15} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="msg-action danger"
              onClick={onDelete}
              title={t('chat.deleteMsg')}
              aria-label={t('chat.deleteMsg')}
            >
              <Icon name="trash" size={15} />
            </button>
          )}
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
        <Icon name="chevron-down" size={13} className="caret" />
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
        <span className="label"><Icon name="sliders" size={15} /></span>
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
        <span className="label"><Icon name="book" size={14} /> {active ? active.name : t('chat.kb')}</span>
        <Icon name="chevron-down" size={13} className="caret" />
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

// SkillsChip — chat-header chip that multi-selects which imported skills are
// active for this conversation (toggled checkboxes; persisted via convoPrefs).
function SkillsChip({
  skills,
  value,
  onChange,
}: {
  skills: SkillMeta[]
  value: string[]
  onChange: (names: string[]) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // No skills imported yet → keep the header tidy.
  if (skills.length === 0) return null

  const active = value.filter((n) => skills.some((s) => s.name === n))

  function toggle(name: string) {
    onChange(active.includes(name) ? active.filter((n) => n !== name) : [...active, name])
  }

  return (
    <div className="kb-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`model-chip kb-chip ${active.length > 0 ? 'override' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={active.length > 0 ? active.join(', ') : t('chat.skillsNone')}
      >
        <span className="label">
          <Icon name="puzzle" size={14} /> {t('chat.skills')}
          {active.length > 0 ? ` (${active.length})` : ''}
        </span>
        <Icon name="chevron-down" size={13} className="caret" />
      </button>
      {open && (
        <div className="kb-chip-popover">
          {skills.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`kb-chip-item ${active.includes(s.name) ? 'active' : ''}`}
              onClick={() => toggle(s.name)}
              title={s.description}
            >
              {active.includes(s.name) && <Icon name="check" size={14} />}
              {s.name}
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

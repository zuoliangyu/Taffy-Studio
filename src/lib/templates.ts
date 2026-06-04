// Assistant templates — reusable "kind of conversation" presets.
//
// A template bundles (name + a subset of per-conversation overrides) so the
// user can spin up a "code reviewer" or "translator" conversation without
// re-typing the system prompt every time.
//
// Storage lives on AppSettings.templates (see settings.ts). When the user
// picks a template at "New chat" time, we copy the override fields into the
// freshly-created conversation row — after that, edits to the template don't
// retroactively change existing conversations. This is the Cherry pattern.

export interface AssistantTemplate {
  /** Stable uuid; survives renames. */
  id: string
  /** Display name in the picker. */
  name: string
  /** Optional one-liner shown beneath the name in the picker. */
  description?: string
  /** Per-template provider override. NULL/undefined = "use global default". */
  providerId?: string | null
  /** Per-template model override (within the chosen provider). */
  model?: string | null
  /** Per-template temperature override. NULL/undefined = "use global default". */
  temperature?: number | null
  /** Per-template system prompt. Empty/undefined = no system message. */
  systemPrompt?: string | null
}

/** Seeds the templates list on a fresh install. Users can edit / delete /
 *  add more in Settings → Assistant templates. */
export function defaultTemplates(): AssistantTemplate[] {
  return [
    {
      id: crypto.randomUUID(),
      name: 'Code reviewer',
      description: 'Reviews a snippet for bugs, style, and clarity.',
      systemPrompt:
        'You are a careful, opinionated code reviewer. When the user pastes a snippet, walk through it line by line, flag concrete bugs first, then style/clarity. Use a numbered list and keep each finding to two sentences. End with "Overall: <one-sentence verdict>".',
      temperature: 0.2,
    },
    {
      id: crypto.randomUUID(),
      name: 'Translator',
      description: 'Translates text, preserving tone and nuance.',
      systemPrompt:
        'You are a professional translator. Translate the user\'s text into the requested target language (ask once if unclear), preserving tone, register, and idiom rather than translating word-for-word. Output only the translation unless the user asks for notes.',
      temperature: 0.4,
    },
    {
      id: crypto.randomUUID(),
      name: 'Summarizer',
      description: 'Distills long content into a concise digest.',
      systemPrompt:
        'You are a summarizer. Reduce the user\'s input to the smallest set of bullets that preserves every load-bearing fact. Prefer concrete numbers and proper nouns; drop hedging. If the input has clear sections, mirror that structure.',
      temperature: 0.3,
    },
  ]
}

// Ask the LLM to generate a short, scannable title for a freshly-started
// conversation. Fire-and-forget: a failure here never blocks chat — we just
// log and leave the default "Conversation N" title in place.
import { chatComplete, type ChatMessage } from './llm'
import { loadSettings, resolveTarget } from './settings'
import { updateConversationTitle } from './db'

const SYSTEM_PROMPT = `You generate a very short title (4–8 words, no quotes, no
trailing punctuation) for a chat conversation, in the same language the user
wrote in. Return ONLY the title text, nothing else.`

/** A title looks "auto-generatable" if it matches the default placeholder we
 *  hand out for new conversations. Anything else means the user customized it
 *  and we must not overwrite. */
export function isDefaultTitle(title: string): boolean {
  return /^Conversation\s+\d+$/i.test(title.trim())
}

/** Summarize the first user/assistant exchange into a short title and persist
 *  it. Caller passes the in-memory copies so we don't depend on DB ordering. */
export async function summarizeAndSave(
  conversationId: string,
  firstUser: string,
  firstAssistant: string,
  providerId?: string,
  modelOverride?: string,
): Promise<string | null> {
  const settings = await loadSettings()
  const target = await resolveTarget(settings, providerId, modelOverride)
  if (!target || !target.apiKey) return null // no key, skip silently

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Conversation:\nUser: ${truncate(firstUser, 800)}\nAssistant: ` +
        `${truncate(firstAssistant, 800)}\n\nTitle:`,
    },
  ]

  try {
    const res = await chatComplete({
      provider: target.provider,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      temperature: 0.3,
      maxTokens: 32,
      messages,
    })
    const title = cleanTitle(res.content)
    if (!title) return null
    await updateConversationTitle(conversationId, title)
    return title
  } catch (e) {
    console.warn('Title summarization failed:', e)
    return null
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Models sometimes return "Title: foo", quoted strings, or trailing periods.
// Trim those down to a clean line.
function cleanTitle(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^["'“”《「『]+|["'“”》」』]+$/g, '')
  t = t.replace(/^(Title|标题)\s*[:：]\s*/i, '')
  t = t.replace(/[.。!！?？]+$/g, '')
  // Take only the first line in case the model padded with explanation.
  t = t.split(/\r?\n/)[0]!.trim()
  // Hard cap so it fits the sidebar.
  if (t.length > 48) t = t.slice(0, 48).trim() + '…'
  return t
}

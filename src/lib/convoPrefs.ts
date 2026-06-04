// Per-conversation, non-content preferences that don't warrant a DB column:
// whether tool use is enabled and which knowledge base (if any) is attached.
// Stored in the Store plugin as a single id→prefs map so it survives restarts
// without another migration.
import { getSetting, setSetting } from './store'

export interface ConvoPrefs {
  toolsEnabled?: boolean
  kbId?: string | null
  /** Skill names enabled for this conversation. */
  enabledSkills?: string[]
}

const STORE_KEY = 'convoPrefs'

type PrefsMap = Record<string, ConvoPrefs>

let _cache: PrefsMap | null = null

async function load(): Promise<PrefsMap> {
  if (_cache) return _cache
  const v = await getSetting<PrefsMap>(STORE_KEY)
  _cache = v && typeof v === 'object' ? v : {}
  return _cache
}

export async function getConvoPrefs(id: string): Promise<ConvoPrefs> {
  const map = await load()
  return map[id] ?? {}
}

export async function setConvoPrefs(id: string, patch: ConvoPrefs): Promise<void> {
  const map = await load()
  map[id] = { ...map[id], ...patch }
  _cache = map
  await setSetting(STORE_KEY, map)
}

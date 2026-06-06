// App settings — multi-provider × multi-model, modeled after Cherry Studio.
//
// Shape (v2):
//   { providers: ProviderEntry[], defaultProviderId, defaultModel, temperature }
//
// Each ProviderEntry stores a curated set of enabled models. The user can
// have multiple providers (e.g. OpenAI direct + a self-hosted gateway + Ollama
// at the same time). Each provider's API key lives in the OS keyring under
// `apiKey:<provider-id>`, so deleting a provider can wipe its secret without
// touching the others.
//
// Backwards compatibility:
//   - If we see the old v1 `providerConfig` blob in Store, we migrate it into
//     a single ProviderEntry + move the legacy `apiKey` keyring slot to the
//     new per-provider slot. Migration runs lazily on first loadSettings().
import { api } from '../services/api'
import type { ModelCapabilityOverride } from './capabilities'
import { deleteSetting, getSetting, setSetting } from './store'
import { defaultTemplates, type AssistantTemplate } from './templates'

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'custom'

export interface ProviderEntry {
  /** Stable uuid; survives renames. */
  id: string
  /** Display name in the UI. */
  name: string
  /** Dispatch tag used by the Rust side. 'custom' is treated as openai-compat. */
  kind: ProviderKind
  /** Endpoint root, e.g. "https://api.openai.com/v1". */
  baseUrl: string
  /** Models the user has curated. The fetched list can be much larger. */
  enabledModels: string[]
  /** Which of `enabledModels` is the per-provider default. */
  defaultModel: string
  /** Per-model capability overrides. Keys are model ids; values are partial
   *  Override blobs where present keys beat the heuristic in capabilities.ts
   *  and absent keys defer to it. Optional so old settings blobs migrate
   *  trivially. */
  modelCapabilities?: Record<string, ModelCapabilityOverride>
}

export interface AppSettings {
  providers: ProviderEntry[]
  /** Global default: which provider new conversations start on. */
  defaultProviderId: string
  /** Convenience: derived model = providers[defaultProviderId].defaultModel. */
  temperature: number
  /** Assistant templates the user can pick from at "New chat" time. Optional
   *  in the type so older v2 blobs migrate trivially — sanitize() backfills
   *  the default presets when the field is missing entirely (vs. empty,
   *  which means "user deleted them all and wants none"). */
  templates?: AssistantTemplate[]
  /** Show per-reply token usage + generation time as the bubble label. When
   *  off, single-model replies show the plain role label and surface the
   *  usage/timing on hover instead. Default on. */
  showReplyMeta?: boolean
}

const STORE_KEY = 'settingsV2'
const LEGACY_KEY = 'providerConfig'

// --- defaults ---

function makeId(): string {
  return crypto.randomUUID()
}

export function defaultSettings(): AppSettings {
  const p: ProviderEntry = {
    id: makeId(),
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    enabledModels: ['gpt-5.4'],
    defaultModel: 'gpt-5.4',
  }
  return {
    providers: [p],
    defaultProviderId: p.id,
    temperature: 0.7,
    templates: defaultTemplates(),
    showReplyMeta: true,
  }
}

// --- legacy (v1) shape used only during migration ---

interface LegacyProviderConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

function legacyKindFromProvider(p: string): ProviderKind {
  const t = (p || '').toLowerCase()
  if (t === 'anthropic' || t === 'claude') return 'anthropic'
  if (t === 'gemini' || t === 'google') return 'gemini'
  if (t === 'openai') return 'openai'
  return 'custom'
}

function prettyName(kind: ProviderKind, raw: string): string {
  if (kind === 'openai') return 'OpenAI'
  if (kind === 'anthropic') return 'Anthropic'
  if (kind === 'gemini') return 'Gemini'
  // For unknown OpenAI-compatible providers (deepseek, siliconflow, …),
  // title-case the raw tag.
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

// --- keyring helpers ---

function apiKeySlot(providerId: string): string {
  return `apiKey:${providerId}`
}

let _secretSupported: boolean | null = null
async function secretSupported(): Promise<boolean> {
  if (_secretSupported !== null) return _secretSupported
  try {
    _secretSupported = await api.secretSupported()
  } catch {
    _secretSupported = false
  }
  return _secretSupported
}

export async function readApiKey(providerId: string): Promise<string> {
  const slot = apiKeySlot(providerId)
  if (await secretSupported()) {
    try {
      const v = await api.secretGet(slot)
      if (v != null) return v
    } catch (e) {
      console.warn('secret_get failed:', e)
    }
  }
  const v = await getSetting<string>(`secret:${slot}`)
  return v ?? ''
}

export async function writeApiKey(providerId: string, value: string): Promise<void> {
  const slot = apiKeySlot(providerId)
  if (await secretSupported()) {
    try {
      await api.secretSet(slot, value)
      await deleteSetting(`secret:${slot}`).catch(() => {})
      return
    } catch (e) {
      console.warn('secret_set failed:', e)
    }
  }
  await setSetting(`secret:${slot}`, value)
}

export async function deleteApiKey(providerId: string): Promise<void> {
  const slot = apiKeySlot(providerId)
  if (await secretSupported()) {
    try {
      await api.secretDelete(slot)
    } catch {
      /* ignore */
    }
  }
  await deleteSetting(`secret:${slot}`).catch(() => {})
}

// --- public API ---

let _cache: AppSettings | null = null

/** Read settings from Store. Runs the v1→v2 migration if needed. */
export async function loadSettings(): Promise<AppSettings> {
  if (_cache) return _cache

  const v2 = await getSetting<AppSettings>(STORE_KEY)
  if (v2 && Array.isArray(v2.providers) && v2.providers.length > 0) {
    _cache = sanitize(v2)
    return _cache
  }

  // Try migrating from v1.
  const legacy = await getSetting<LegacyProviderConfig>(LEGACY_KEY)
  if (legacy && legacy.baseUrl) {
    const migrated = await migrateFromLegacy(legacy)
    await saveSettings(migrated)
    // Wipe the old key so we never re-migrate.
    await deleteSetting(LEGACY_KEY).catch(() => {})
    _cache = migrated
    return _cache
  }

  const fresh = defaultSettings()
  await saveSettings(fresh)
  _cache = fresh
  return fresh
}

async function migrateFromLegacy(old: LegacyProviderConfig): Promise<AppSettings> {
  const kind = legacyKindFromProvider(old.provider)
  const provider: ProviderEntry = {
    id: makeId(),
    name: prettyName(kind, old.provider),
    kind,
    baseUrl: old.baseUrl,
    enabledModels: old.model ? [old.model] : [],
    defaultModel: old.model || '',
  }
  // The legacy keyring slot was just "apiKey"; move it under the new
  // per-provider name.
  try {
    if (await secretSupported()) {
      const old_key = await api.secretGet('apiKey')
      if (old_key) {
        await api.secretSet(apiKeySlot(provider.id), old_key)
        await api.secretDelete('apiKey')
      }
    } else if (old.apiKey) {
      // v1 may have been storing the key inline (very early dev). Move it.
      await writeApiKey(provider.id, old.apiKey)
    }
  } catch (e) {
    console.warn('legacy key migration failed:', e)
  }
  return {
    providers: [provider],
    defaultProviderId: provider.id,
    temperature: old.temperature ?? 0.7,
    templates: defaultTemplates(),
  }
}

/** Defensive: re-derive defaultProviderId / per-provider defaultModel if the
 *  saved blob got into a weird state (e.g. a provider was deleted manually). */
function sanitize(s: AppSettings): AppSettings {
  const providers = (s.providers ?? []).filter(
    (p): p is ProviderEntry => !!p && typeof p.id === 'string',
  )
  for (const p of providers) {
    if (!p.enabledModels) p.enabledModels = []
    if (!p.defaultModel && p.enabledModels[0]) p.defaultModel = p.enabledModels[0]
    if (p.defaultModel && !p.enabledModels.includes(p.defaultModel)) {
      p.enabledModels = [p.defaultModel, ...p.enabledModels]
    }
  }
  let defaultProviderId = s.defaultProviderId
  if (!providers.some((p) => p.id === defaultProviderId)) {
    defaultProviderId = providers[0]?.id ?? ''
  }
  // templates: undefined means "old v2 blob without the field" → seed
  // defaults. An empty array means "user explicitly cleared the list" and
  // we leave it alone (so sanitize doesn't keep resurrecting deleted ones).
  const templates =
    s.templates === undefined
      ? defaultTemplates()
      : Array.isArray(s.templates)
        ? s.templates.filter((t): t is AssistantTemplate => !!t && typeof t.id === 'string')
        : []
  return {
    providers,
    defaultProviderId,
    temperature: typeof s.temperature === 'number' ? s.temperature : 0.7,
    templates,
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const clean = sanitize(s)
  await setSetting(STORE_KEY, clean)
  _cache = clean
}

/** Look up a provider by id, or return the default one. */
export function getProvider(s: AppSettings, id?: string): ProviderEntry | undefined {
  if (id) return s.providers.find((p) => p.id === id)
  return s.providers.find((p) => p.id === s.defaultProviderId) ?? s.providers[0]
}

/**
 * Bundle a (provider, model) pair for use with chatStream / chat_complete.
 * Pulls the API key from the keyring on demand.
 */
export interface ResolvedChatTarget {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export async function resolveTarget(
  s: AppSettings,
  providerId?: string,
  modelOverride?: string,
  temperatureOverride?: number | null,
): Promise<ResolvedChatTarget | null> {
  const provider = getProvider(s, providerId)
  if (!provider) return null
  const model = modelOverride || provider.defaultModel || provider.enabledModels[0] || ''
  if (!model) return null
  const apiKey = await readApiKey(provider.id)
  // Override > global default. null/undefined both fall back to global.
  const temperature =
    typeof temperatureOverride === 'number' ? temperatureOverride : s.temperature
  return {
    provider: provider.kind === 'custom' ? provider.name.toLowerCase() : provider.kind,
    baseUrl: provider.baseUrl,
    apiKey,
    model,
    temperature,
  }
}

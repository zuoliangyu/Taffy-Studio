// Multi-provider × multi-model settings panel, modeled after Cherry Studio.
//
// Layout:
//   ┌──────────┬─────────────────────────────────┐
//   │ Sidebar  │  Selected provider's fields:    │
//   │ - OpenAI │  name / kind / baseUrl / apiKey │
//   │ - Anthr. │  + curated models (multi-select │
//   │ - Local  │     w/ ⭐ for per-provider def.) │
//   │ + Add    │                                 │
//   ├──────────┴─────────────────────────────────┤
//   │ Temperature                                │
//   │ Storage panel (existing)                   │
//   └────────────────────────────────────────────┘
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, type TFunc } from '../i18n'
import { localeNames, type Locale, type TKey } from '../i18n/strings'
import { useTheme, type ThemeMode } from '../lib/theme'
import {
  getModelCapabilities,
  inferModelCapabilities,
  setModelCapabilityOverride,
} from '../lib/capabilities'
import { listModels } from '../lib/llm'
import { McpPanel } from './McpPanel'
import { SkillsPanel } from './SkillsPanel'
import { KnowledgePanel } from './KnowledgePanel'
import {
  defaultSettings,
  deleteApiKey,
  loadSettings,
  readApiKey,
  saveSettings,
  writeApiKey,
  type AppSettings,
  type ProviderEntry,
  type ProviderKind,
} from '../lib/settings'
import type { AssistantTemplate } from '../lib/templates'
import { StoragePanel } from './StoragePanel'
import { Icon, type IconName } from './Icon'
import logoUrl from '../assets/logo.png'

interface Props {
  open: boolean
  onClose: () => void
}

// Top-level settings sections shown in the left nav rail.
type SettingsSection =
  | 'providers'
  | 'appearance'
  | 'mcp'
  | 'skills'
  | 'knowledge'
  | 'templates'
  | 'storage'
  | 'about'

// Result of the "Check" button next to the API key.
type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok' }
  | { status: 'error'; message: string }

const PROVIDER_PRESETS: { name: string; kind: ProviderKind; baseUrl: string; model: string }[] = [
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
  { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
  { name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
  { name: 'DeepSeek', kind: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'SiliconFlow', kind: 'custom', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { name: 'Ollama (local)', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
]

// Left-rail sections. `labelKey` is resolved through t() so the rail is
// fully localized.
const SECTIONS: { key: SettingsSection; labelKey: TKey }[] = [
  { key: 'providers', labelKey: 'settings.navProviders' },
  { key: 'appearance', labelKey: 'settings.appearance' },
  { key: 'mcp', labelKey: 'settings.mcp' },
  { key: 'skills', labelKey: 'settings.skills' },
  { key: 'knowledge', labelKey: 'settings.knowledge' },
  { key: 'templates', labelKey: 'settings.templates' },
  { key: 'storage', labelKey: 'settings.storage' },
  { key: 'about', labelKey: 'settings.about' },
]

// Maps each settings section to a shared Icon glyph (single source of truth —
// the bespoke inline SVGs were replaced by the project-wide Icon set).
const SECTION_ICON: Record<SettingsSection, IconName> = {
  providers: 'layers',
  appearance: 'sun',
  mcp: 'plug',
  skills: 'puzzle',
  knowledge: 'book',
  templates: 'layout',
  storage: 'database',
  about: 'info',
}

function SectionIcon({ name }: { name: SettingsSection }) {
  return <Icon name={SECTION_ICON[name]} size={17} />
}

export function SettingsPanel({ open, onClose }: Props) {
  const { t, locale, setLocale } = useI18n()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const [s, setS] = useState<AppSettings | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // Which top-level settings section is showing in the right pane.
  const [section, setSection] = useState<SettingsSection>('providers')
  // API key is loaded from keyring per-provider on demand.
  const [apiKey, setApiKey] = useState<string>('')
  const [showKey, setShowKey] = useState(false)
  // Connectivity check for the current key/baseUrl.
  const [checkState, setCheckState] = useState<CheckState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) return
    ;(async () => {
      const loaded = await loadSettings()
      setS(loaded)
      const initId = loaded.defaultProviderId || loaded.providers[0]?.id || null
      setActiveId(initId)
      if (initId) setApiKey(await readApiKey(initId))
      setShowKey(false)
      setCheckState({ status: 'idle' })
      setFetchedModels([])
      setModelsError(null)
    })().catch(console.error)
  }, [open])

  const active = useMemo<ProviderEntry | null>(
    () => s?.providers.find((p) => p.id === activeId) ?? null,
    [s, activeId],
  )

  // Models to show in the picker = enabled (always) ∪ fetched.
  // MUST live above the conditional returns below — Rules of Hooks.
  const allCandidates = useMemo(() => {
    const set = new Set<string>(active?.enabledModels ?? [])
    for (const m of fetchedModels) set.add(m)
    return Array.from(set).sort()
  }, [active, fetchedModels])

  if (!open) return null
  if (!s) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p>{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  function patchActive(patch: Partial<ProviderEntry>) {
    if (!active) return
    setS((cur) => {
      if (!cur) return cur
      return {
        ...cur,
        providers: cur.providers.map((p) =>
          p.id === active.id ? { ...p, ...patch } : p,
        ),
      }
    })
  }

  async function onSwitchProvider(id: string) {
    setActiveId(id)
    setApiKey(await readApiKey(id))
    setShowKey(false)
    setCheckState({ status: 'idle' })
    setFetchedModels([])
    setModelsError(null)
  }

  // Lightweight connectivity probe: reuse listModels() — if the provider
  // answers without throwing, the key + baseUrl are good.
  async function onCheckKey() {
    if (!active || checkState.status === 'checking') return
    setCheckState({ status: 'checking' })
    try {
      await listModels({
        provider: active.kind === 'custom' ? active.name.toLowerCase() : active.kind,
        baseUrl: active.baseUrl,
        apiKey,
        model: active.defaultModel || '',
        messages: [],
      })
      setCheckState({ status: 'ok' })
    } catch (e) {
      setCheckState({ status: 'error', message: String(e) })
    }
  }

  function onAddPreset(preset: typeof PROVIDER_PRESETS[number]) {
    const id = crypto.randomUUID()
    const newP: ProviderEntry = {
      id,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      enabledModels: [preset.model],
      defaultModel: preset.model,
    }
    setS((cur) => (cur ? { ...cur, providers: [...cur.providers, newP] } : cur))
    setActiveId(id)
    setApiKey('')
    setShowKey(false)
    setCheckState({ status: 'idle' })
    setFetchedModels([])
    setAdding(false)
  }

  function onAddBlank() {
    const id = crypto.randomUUID()
    const newP: ProviderEntry = {
      id,
      name: 'Custom',
      kind: 'custom',
      baseUrl: '',
      enabledModels: [],
      defaultModel: '',
    }
    setS((cur) => (cur ? { ...cur, providers: [...cur.providers, newP] } : cur))
    setActiveId(id)
    setApiKey('')
    setShowKey(false)
    setCheckState({ status: 'idle' })
    setFetchedModels([])
    setAdding(false)
  }

  async function onDeleteProvider() {
    if (!active || !s) return
    if (s.providers.length === 1) return // refuse to delete the last one
    if (!confirm(t('settings.confirmDelete', { name: active.name }))) return
    await deleteApiKey(active.id)
    setS((cur) => {
      if (!cur) return cur
      const next = cur.providers.filter((p) => p.id !== active.id)
      const newDefault = cur.defaultProviderId === active.id ? (next[0]?.id ?? '') : cur.defaultProviderId
      return { ...cur, providers: next, defaultProviderId: newDefault }
    })
    // Switch UI to whatever's left.
    const remaining = s.providers.find((p) => p.id !== active.id)
    if (remaining) onSwitchProvider(remaining.id)
  }

  function onMakeDefault() {
    if (!active || !s) return
    setS((cur) => (cur ? { ...cur, defaultProviderId: active.id } : cur))
  }

  async function onSave() {
    if (!s) return
    setSaving(true)
    try {
      await saveSettings(s)
      if (active) await writeApiKey(active.id, apiKey)
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  async function onFetchModels() {
    if (!active || fetchingModels) return
    setFetchingModels(true)
    setModelsError(null)
    try {
      const list = await listModels({
        provider: active.kind === 'custom' ? active.name.toLowerCase() : active.kind,
        baseUrl: active.baseUrl,
        apiKey,
        model: active.defaultModel || '',
        messages: [],
      })
      setFetchedModels(list)
      if (list.length === 0) setModelsError('Provider returned an empty list.')
    } catch (e) {
      setModelsError(String(e))
    } finally {
      setFetchingModels(false)
    }
  }

  function toggleModel(modelId: string) {
    if (!active) return
    const enabled = active.enabledModels.includes(modelId)
    let next: string[]
    if (enabled) {
      next = active.enabledModels.filter((m) => m !== modelId)
    } else {
      next = [...active.enabledModels, modelId]
    }
    const newDefault =
      enabled && active.defaultModel === modelId
        ? (next[0] ?? '')
        : active.defaultModel || modelId
    patchActive({ enabledModels: next, defaultModel: newDefault })
  }

  function setDefaultModel(modelId: string) {
    if (!active) return
    const enabled = active.enabledModels.includes(modelId)
      ? active.enabledModels
      : [...active.enabledModels, modelId]
    patchActive({ enabledModels: enabled, defaultModel: modelId })
  }

  function addModelManually(input: string) {
    if (!active) return
    const v = input.trim()
    if (!v) return
    if (active.enabledModels.includes(v)) return
    patchActive({
      enabledModels: [...active.enabledModels, v],
      defaultModel: active.defaultModel || v,
    })
  }

  // ---- AssistantTemplate editing ----

  function patchTemplates(next: AssistantTemplate[]) {
    setS((cur) => (cur ? { ...cur, templates: next } : cur))
  }

  function patchTemplate(id: string, patch: Partial<AssistantTemplate>) {
    if (!s) return
    patchTemplates(
      (s.templates ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
    )
  }

  function deleteTemplate(id: string) {
    if (!s) return
    patchTemplates((s.templates ?? []).filter((t) => t.id !== id))
  }

  function addBlankTemplate() {
    if (!s) return
    const blank: AssistantTemplate = {
      id: crypto.randomUUID(),
      name: 'Untitled template',
      systemPrompt: '',
    }
    patchTemplates([...(s.templates ?? []), blank])
  }

  /** Toggle the vision capability for a model. If the resulting effective
   *  value would equal the heuristic guess, drop the override entirely so
   *  later heuristic improvements still apply automatically. */
  function toggleVision(modelId: string) {
    if (!active) return
    const heuristic = inferModelCapabilities(modelId).vision
    const currentEffective = getModelCapabilities(active, modelId).vision
    const nextEffective = !currentEffective
    const updated = setModelCapabilityOverride(
      active,
      modelId,
      'vision',
      nextEffective === heuristic ? undefined : nextEffective,
    )
    patchActive({ modelCapabilities: updated.modelCapabilities })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-shell" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>{t('settings.title')}</h2>
          <button
            type="button"
            className="close-x"
            onClick={onClose}
            aria-label={t('common.close')}
            title={`${t('common.close')} (Esc)`}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="settings-main">
          {/* ===== Left category nav ===== */}
          <nav className="set-nav">
            {SECTIONS.map((sec) => (
              <button
                key={sec.key}
                type="button"
                className={`set-nav-item ${section === sec.key ? 'active' : ''}`}
                onClick={() => setSection(sec.key)}
              >
                <SectionIcon name={sec.key} />
                {t(sec.labelKey)}
              </button>
            ))}
          </nav>

          {/* ===== Right content ===== */}
          <div className="set-content">
            {section === 'providers' && (
              active ? (
                <>
                  {/* provider switcher + per-provider actions */}
                  <div className="set-pswitch">
                    {s.providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`set-chip ${p.id === activeId ? 'active' : ''}`}
                        onClick={() => onSwitchProvider(p.id)}
                      >
                        <span className="dot" data-kind={p.kind} />
                        <span className="set-chip-name">{p.name || '(unnamed)'}</span>
                        {p.id === s.defaultProviderId && (
                          <span className="set-chip-tag">{t('settings.defaultTag')}</span>
                        )}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="set-chip add"
                      onClick={() => setAdding((a) => !a)}
                    >
                      {t('settings.add')}
                    </button>
                    <span className="set-spacer" />
                    <button
                      type="button"
                      className={`set-icon-btn star ${active.id === s.defaultProviderId ? 'on' : ''}`}
                      onClick={onMakeDefault}
                      title={t('settings.makeDefault')}
                      aria-label={t('settings.makeDefault')}
                    >
                      <Icon name="star" size={16} filled={active.id === s.defaultProviderId} />
                    </button>
                    {s.providers.length > 1 && (
                      <button
                        type="button"
                        className="set-icon-btn danger"
                        onClick={onDeleteProvider}
                        title={t('settings.deleteProvider')}
                        aria-label={t('settings.deleteProvider')}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>

                  {adding && (
                    <div className="set-preset-row">
                      {PROVIDER_PRESETS.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          className="set-chip"
                          onClick={() => onAddPreset(p)}
                        >
                          {p.name}
                        </button>
                      ))}
                      <button type="button" className="set-chip" onClick={onAddBlank}>
                        {t('settings.custom')}
                      </button>
                    </div>
                  )}

                  {/* card: basics */}
                  <div className="set-card">
                    <div className="set-card-title">
                      {t('settings.sectionBasics')}
                      <span className="set-line" />
                    </div>
                    <div className="set-grid2">
                      <div className="set-field">
                        <label>{t('settings.name')}</label>
                        <input
                          className="set-ctl"
                          value={active.name}
                          onChange={(e) => patchActive({ name: e.target.value })}
                          placeholder="OpenAI, DeepSeek, …"
                        />
                      </div>
                      <div className="set-field">
                        <label>{t('settings.protocol')}</label>
                        <select
                          className="set-ctl"
                          value={active.kind}
                          onChange={(e) => patchActive({ kind: e.target.value as ProviderKind })}
                        >
                          <option value="openai">{t('settings.protoOpenai')}</option>
                          <option value="anthropic">{t('settings.protoAnthropic')}</option>
                          <option value="gemini">{t('settings.protoGemini')}</option>
                          <option value="custom">{t('settings.protoCustom')}</option>
                        </select>
                      </div>
                    </div>
                    <small className="set-hint">{t('settings.nameHint')}</small>
                  </div>

                  {/* card: endpoint & key */}
                  <div className="set-card">
                    <div className="set-card-title">
                      {t('settings.sectionEndpoint')}
                      <span className="set-line" />
                    </div>
                    <div className="set-field">
                      <label>{t('settings.baseUrl')}</label>
                      <input
                        className="set-ctl"
                        value={active.baseUrl}
                        onChange={(e) => patchActive({ baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div className="set-field">
                      <label>{t('settings.apiKey')}</label>
                      <div className="set-inline">
                        <input
                          className="set-ctl"
                          type={showKey ? 'text' : 'password'}
                          value={apiKey}
                          onChange={(e) => {
                            setApiKey(e.target.value)
                            setCheckState({ status: 'idle' })
                          }}
                          placeholder="sk-…"
                        />
                        <button
                          type="button"
                          className="set-btn eye"
                          onClick={() => setShowKey((v) => !v)}
                          title={showKey ? t('settings.hideKey') : t('settings.showKey')}
                          aria-label={showKey ? t('settings.hideKey') : t('settings.showKey')}
                        >
                          <Icon name={showKey ? 'eye-off' : 'eye'} size={16} />
                        </button>
                        <button
                          type="button"
                          className="set-btn outline"
                          onClick={onCheckKey}
                          disabled={checkState.status === 'checking' || !apiKey}
                        >
                          {checkState.status === 'checking' ? t('settings.checking') : t('settings.check')}
                        </button>
                      </div>
                      <small className="set-hint">
                        {checkState.status === 'ok' && (
                          <span className="set-check-ok"><Icon name="check" size={14} /> {t('settings.checkOk')}</span>
                        )}
                        {checkState.status === 'error' && (
                          <span className="set-check-err" title={checkState.message}>
                            <Icon name="alert" size={14} /> {checkState.message}
                          </span>
                        )}
                        {checkState.status !== 'error' && (
                          <>
                            {checkState.status === 'ok' ? ' · ' : ''}
                            {t('settings.apiKeyHint')}
                          </>
                        )}
                      </small>
                    </div>
                  </div>

                  {/* card: models */}
                  <div className="set-card">
                    <div className="set-card-title">
                      {t('settings.models')}
                      <span className="set-line" />
                    </div>
                    <ModelManager
                      active={active}
                      allCandidates={allCandidates}
                      onToggle={toggleModel}
                      onSetDefault={setDefaultModel}
                      onAddManual={addModelManually}
                      onToggleVision={toggleVision}
                      onFetch={onFetchModels}
                      fetching={fetchingModels}
                      apiKeyAvailable={!!apiKey}
                      error={modelsError}
                      t={t}
                    />
                  </div>
                </>
              ) : (
                <p className="muted">{t('settings.pickProvider')}</p>
              )
            )}

            {section === 'appearance' && (
              <div className="set-card">
                <div className="set-card-title">
                  {t('settings.appearance')}
                  <span className="set-line" />
                </div>
                <div className="set-appearance-row">
                  <span className="set-appearance-label">{t('settings.language')}</span>
                  <div className="seg-control">
                    {(Object.keys(localeNames) as Locale[]).map((l) => (
                      <button
                        key={l}
                        type="button"
                        className={`seg ${locale === l ? 'active' : ''}`}
                        onClick={() => setLocale(l)}
                      >
                        {localeNames[l]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="set-appearance-row">
                  <span className="set-appearance-label">{t('settings.theme')}</span>
                  <div className="seg-control">
                    {(
                      [
                        ['system', t('settings.themeSystem')],
                        ['light', t('settings.themeLight')],
                        ['dark', t('settings.themeDark')],
                      ] as [ThemeMode, string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        className={`seg ${themeMode === m ? 'active' : ''}`}
                        onClick={() => setThemeMode(m)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {section === 'mcp' && <McpPanel />}
            {section === 'skills' && <SkillsPanel />}
            {section === 'knowledge' && <KnowledgePanel settings={s} />}
            {section === 'templates' && (
              <TemplatesEditor
                templates={s.templates ?? []}
                providers={s.providers}
                onPatch={patchTemplate}
                onDelete={deleteTemplate}
                onAdd={addBlankTemplate}
              />
            )}
            {section === 'storage' && <StoragePanel />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>

        <footer className="settings-foot">
          {savedAt > 0 && <span className="muted saved-tag">{t('common.saved')}</span>}
          <button type="button" onClick={onClose} className="ghost">{t('common.close')}</button>
          <button type="button" onClick={onSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </footer>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Models manager
// -----------------------------------------------------------------------------

interface MMProps {
  active: ProviderEntry
  allCandidates: string[]
  onToggle: (m: string) => void
  onSetDefault: (m: string) => void
  onAddManual: (m: string) => void
  onToggleVision: (m: string) => void
  onFetch: () => void
  fetching: boolean
  apiKeyAvailable: boolean
  error: string | null
  t: TFunc
}

function ModelManager({
  active,
  allCandidates,
  onToggle,
  onSetDefault,
  onAddManual,
  onToggleVision,
  onFetch,
  fetching,
  apiKeyAvailable,
  error,
  t,
}: MMProps) {
  const [manualInput, setManualInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const isEnabled = (m: string) => active.enabledModels.includes(m)
  const isDefault = (m: string) => active.defaultModel === m

  return (
    <>
      <div className="set-models-head">
        <span className="set-models-count">
          {t('settings.enabledCount', { n: active.enabledModels.length })}
        </span>
        <button
          type="button"
          className="set-btn"
          onClick={onFetch}
          disabled={fetching || !apiKeyAvailable}
          title={apiKeyAvailable ? t('settings.fetchHint') : t('settings.addApiKeyFirst')}
        >
          {fetching ? '…' : t('settings.fetch')}
        </button>
      </div>

      <div className="set-mlist">
        {allCandidates.length === 0 ? (
          <p className="set-models-empty">{t('settings.noModels')}</p>
        ) : (
          allCandidates.map((m) => {
            const caps = getModelCapabilities(active, m)
            const heuristic = inferModelCapabilities(m)
            const visionOverridden =
              active.modelCapabilities?.[m]?.vision !== undefined
            const visionTitle = visionOverridden
              ? `Vision override: ${caps.vision ? 'forced on' : 'forced off'} · click to revert to heuristic (${heuristic.vision ? 'on' : 'off'})`
              : `Vision (heuristic): ${caps.vision ? 'supported' : 'not supported'} · click to override`
            return (
              <div key={m} className={`set-mrow ${isEnabled(m) ? 'on' : ''}`}>
                <label className="set-mcheck">
                  <input
                    type="checkbox"
                    checked={isEnabled(m)}
                    onChange={() => onToggle(m)}
                  />
                  <span className="set-mname">{m}</span>
                </label>
                <button
                  type="button"
                  className={`set-badge vision ${caps.vision ? 'on' : 'off'} ${visionOverridden ? 'overridden' : ''}`}
                  onClick={() => onToggleVision(m)}
                  title={visionTitle}
                  aria-label={visionTitle}
                  aria-pressed={caps.vision}
                >
                  <Icon name="eye" size={15} />
                </button>
                <button
                  type="button"
                  className={`set-star ${isDefault(m) ? 'on' : ''}`}
                  onClick={() => onSetDefault(m)}
                  title={isDefault(m) ? t('settings.makeDefault') : t('settings.makeDefault')}
                  aria-label={t('settings.makeDefault')}
                >
                  <Icon name="star" size={15} filled={isDefault(m)} />
                </button>
              </div>
            )
          })
        )}
      </div>

      <div className="set-madd">
        <input
          className="set-ctl"
          ref={inputRef}
          placeholder={t('settings.typeModel')}
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onAddManual(manualInput)
              setManualInput('')
            }
          }}
        />
        <button
          type="button"
          className="set-btn"
          onClick={() => {
            onAddManual(manualInput)
            setManualInput('')
            inputRef.current?.focus()
          }}
          disabled={!manualInput.trim()}
        >
          {t('settings.addModel')}
        </button>
      </div>

      {error && <small className="set-check-err">{error}</small>}
    </>
  )
}

// Keep the previously-imported function name available for unused-import safety.
// (Not really needed; defaultSettings() is referenced indirectly via loadSettings()
//  but TS strict mode complains otherwise.)
void defaultSettings

// -----------------------------------------------------------------------------
// TemplatesEditor — inline cards for each Assistant template. Edits are local
// to AppSettings; the outer Save button persists them via saveSettings().
// -----------------------------------------------------------------------------

interface TEProps {
  templates: AssistantTemplate[]
  providers: ProviderEntry[]
  onPatch: (id: string, patch: Partial<AssistantTemplate>) => void
  onDelete: (id: string) => void
  onAdd: () => void
}

function TemplatesEditor({
  templates,
  providers,
  onPatch,
  onDelete,
  onAdd,
}: TEProps) {
  const { t } = useI18n()
  return (
    <div className="templates-editor">
      <p className="tpl-hint muted-small">{t('tpl.hint')}</p>
      {templates.length === 0 ? (
        <p className="muted-small">{t('tpl.empty')}</p>
      ) : (
        templates.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            providers={providers}
            onPatch={(patch) => onPatch(t.id, patch)}
            onDelete={() => onDelete(t.id)}
          />
        ))
      )}
      <div className="templates-editor-foot">
        <button type="button" className="ghost small" onClick={onAdd}>
          <Icon name="plus" size={14} /> {t('tpl.add')}
        </button>
      </div>
    </div>
  )
}

interface TCProps {
  template: AssistantTemplate
  providers: ProviderEntry[]
  onPatch: (patch: Partial<AssistantTemplate>) => void
  onDelete: () => void
}

function TemplateCard({ template, providers, onPatch, onDelete }: TCProps) {
  const { t } = useI18n()
  const provider = providers.find((p) => p.id === template.providerId)
  // Model options only make sense after a specific provider is picked;
  // "inherit" disables the model field entirely.
  const modelOptions = provider?.enabledModels ?? []
  return (
    <div className="template-card">
      <div className="template-card-head">
        <input
          className="template-card-name"
          value={template.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder={t('tpl.namePlaceholder')}
        />
        <button
          type="button"
          className="icon-only destructive-btn"
          onClick={onDelete}
          title={t('tpl.deleteTemplate')}
          aria-label={t('tpl.deleteTemplate')}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
      <input
        className="template-card-desc"
        value={template.description ?? ''}
        onChange={(e) => onPatch({ description: e.target.value || undefined })}
        placeholder={t('tpl.descPlaceholder')}
      />
      <div className="template-card-row">
        <label className="template-field">
          <span>{t('tpl.provider')}</span>
          <select
            value={template.providerId ?? ''}
            onChange={(e) => {
              const next = e.target.value || null
              // Picking a new provider invalidates the previous model.
              onPatch({ providerId: next, model: null })
            }}
          >
            <option value="">{t('tpl.globalDefault')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="template-field">
          <span>{t('tpl.model')}</span>
          <select
            value={template.model ?? ''}
            onChange={(e) => onPatch({ model: e.target.value || null })}
            disabled={!provider}
            title={provider ? undefined : t('tpl.pickProviderFirst')}
          >
            <option value="">{provider ? t('tpl.providerDefault') : t('tpl.inherit')}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="template-field template-field-num">
          <span>{t('tpl.temp')}</span>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={template.temperature ?? ''}
            onChange={(e) => {
              const v = e.target.value
              const n = v === '' ? null : Number.parseFloat(v)
              onPatch({ temperature: n === null || Number.isFinite(n) ? n : null })
            }}
            placeholder={t('tpl.tempPlaceholder')}
          />
        </label>
      </div>
      <label className="template-field template-field-prompt">
        <span>{t('tpl.systemPrompt')}</span>
        <textarea
          rows={4}
          value={template.systemPrompt ?? ''}
          onChange={(e) => onPatch({ systemPrompt: e.target.value })}
          placeholder={t('tpl.systemPromptPlaceholder')}
        />
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------
// About — author, links, and an update check. External links + the updater are
// Tauri-only; they degrade gracefully (no-op / window.open) on the web shell.
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/zuoliangyu/Taffy-Studio'
const AUTHOR_GITHUB = 'https://github.com/zuoliangyu'
const BILIBILI_URL = 'https://space.bilibili.com/27619688'

async function openExternal(url: string) {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    try {
      window.open(url, '_blank', 'noopener')
    } catch {
      /* ignore */
    }
  }
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'error' }

function AboutSection() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const [upd, setUpd] = useState<UpdateState>({ kind: 'idle' })

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => {})
  }, [])

  async function checkUpdate() {
    setUpd({ kind: 'checking' })
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      setUpd(update ? { kind: 'available', version: update.version } : { kind: 'uptodate' })
    } catch {
      setUpd({ kind: 'error' })
    }
  }

  return (
    <div className="about">
      <div className="set-card about-hero">
        <div className="about-mark">
          <img src={logoUrl} alt="Taffy Studio" />
        </div>
        <div className="about-name">Taffy Studio</div>
        {version && (
          <div className="muted-small">
            {t('about.version')} {version}
          </div>
        )}
        <button
          type="button"
          className="set-btn outline about-update"
          onClick={checkUpdate}
          disabled={upd.kind === 'checking'}
        >
          <Icon name="refresh" size={15} />{' '}
          {upd.kind === 'checking' ? t('about.checking') : t('about.checkUpdate')}
        </button>
        {upd.kind === 'uptodate' && (
          <div className="set-check-ok">
            <Icon name="check" size={14} /> {t('about.upToDate')}
          </div>
        )}
        {upd.kind === 'available' && (
          <button type="button" className="about-link" onClick={() => openExternal(REPO_URL + '/releases/latest')}>
            <Icon name="download" size={15} /> {t('about.updateAvailable', { v: upd.version })}
          </button>
        )}
        {upd.kind === 'error' && (
          <div className="set-check-err">
            <Icon name="alert" size={14} /> {t('about.updateError')}
          </div>
        )}
      </div>

      <div className="set-card">
        <div className="set-card-title">
          {t('about.author')} <span className="set-line" />
        </div>
        <div className="about-author">左岚 · zuoliangyu</div>
        <div className="about-links">
          <button type="button" className="about-link" onClick={() => openExternal(BILIBILI_URL)}>
            <Icon name="globe" size={15} /> {t('about.bilibili')}
            <Icon name="external" size={13} className="about-ext" />
          </button>
          <button type="button" className="about-link" onClick={() => openExternal(AUTHOR_GITHUB)}>
            <Icon name="github" size={15} /> {t('about.authorGithub')}
            <Icon name="external" size={13} className="about-ext" />
          </button>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-title">
          {t('about.openSource')} <span className="set-line" />
        </div>
        <div className="about-links">
          <button type="button" className="about-link" onClick={() => openExternal(REPO_URL)}>
            <Icon name="github" size={15} /> {t('about.repo')}
            <Icon name="external" size={13} className="about-ext" />
          </button>
        </div>
      </div>
    </div>
  )
}

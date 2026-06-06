// Header chip showing the (Provider · Model) used by the current conversation,
// plus a popover that lets the user switch to any enabled model across any
// configured provider. Picking a model writes the override into the
// conversations row — the global default is untouched.
//
// This same popover (with `position` props) is reused by the composer's
// @-mention trigger; that's why the inner list is split out as ModelList.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { getModelCapabilities } from '../lib/capabilities'
import type { AppSettings, ProviderEntry } from '../lib/settings'
import { Icon } from './Icon'

interface PickerProps {
  settings: AppSettings
  providerId: string
  model: string
  onPick: (providerId: string, model: string) => void
}

export function ModelPicker({ settings, providerId, model, onPick }: PickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const provider = settings.providers.find((p) => p.id === providerId)
  const label = provider ? `${provider.name} · ${model || '(no model)'}` : '(no provider)'

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="model-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="model-chip"
        onClick={() => setOpen((o) => !o)}
        title={t('model.switchTitle')}
      >
        <span className="dot" data-kind={provider?.kind ?? 'custom'} />
        <span className="label">{label}</span>
        <Icon name="chevron-down" size={13} className="caret" />
      </button>
      {open && (
        <div className="model-chip-popover">
          <ModelList
            settings={settings}
            currentProviderId={providerId}
            currentModel={model}
            onPick={(pid, m) => {
              onPick(pid, m)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// ModelList — also reused by the @ mention popover in the composer.
// -----------------------------------------------------------------------------

interface ListProps {
  settings: AppSettings
  currentProviderId?: string
  currentModel?: string
  /** Optional search filter applied to model ids and provider names. */
  filter?: string
  /** When true, models whose effective capabilities lack `vision` are
   *  rendered disabled (greyed, not clickable, skipped by arrow-key nav).
   *  Set by the chat panel when the composer has pending image attachments. */
  requireVision?: boolean
  /** Notify when the user picks (or hits Enter on the highlighted row). */
  onPick: (providerId: string, model: string) => void
  /** Mutable container the composer fills with an imperative handle; lets
   *  arrow-key navigation drive this list without lifting state up. */
  forwardRef?: { current: ModelListHandle | null }
}

export interface ModelListHandle {
  /** Move highlight by delta; -1 / +1 used by composer arrow keys. */
  step: (delta: number) => void
  /** Trigger the currently-highlighted row. */
  pickCurrent: () => void
}

interface Flat {
  provider: ProviderEntry
  model: string
  /** True when the row is permitted by the active filter (only false when
   *  requireVision is set and this model can't do vision). Kept on the flat
   *  entry so the group layout below can still render the row but mark it
   *  disabled, instead of dropping it entirely. */
  enabled: boolean
}

export function ModelList({
  settings,
  currentProviderId,
  currentModel,
  filter,
  requireVision,
  onPick,
  forwardRef,
}: ListProps) {
  const flat: Flat[] = useMemo(() => {
    const out: Flat[] = []
    for (const p of settings.providers) {
      for (const m of p.enabledModels) {
        const caps = getModelCapabilities(p, m)
        const enabled = !requireVision || caps.vision
        out.push({ provider: p, model: m, enabled })
      }
    }
    if (!filter) return out
    const q = filter.toLowerCase()
    return out.filter(
      (f) => f.model.toLowerCase().includes(q) || f.provider.name.toLowerCase().includes(q),
    )
  }, [settings, filter, requireVision])

  // Pre-select the current entry, or the first ENABLED one when filtering.
  const initialIdx = useMemo(() => {
    if (flat.length === 0) return -1
    const found = flat.findIndex(
      (f) =>
        f.provider.id === currentProviderId && f.model === currentModel && f.enabled,
    )
    if (found >= 0) return found
    const firstEnabled = flat.findIndex((f) => f.enabled)
    return firstEnabled >= 0 ? firstEnabled : 0
  }, [flat, currentProviderId, currentModel])

  const [highlight, setHighlight] = useState(initialIdx)
  // Reset highlight when the filtered list changes (e.g. composer @search).
  useEffect(() => setHighlight(initialIdx), [initialIdx])

  // Imperative handle for keyboard nav from the composer. Arrow keys skip
  // over disabled rows so the user can't tab their way into a model that
  // would silently drop their attachments.
  useEffect(() => {
    if (!forwardRef) return
    forwardRef.current = {
      step: (delta: number) =>
        setHighlight((h) => {
          if (flat.length === 0) return -1
          const n = flat.length
          let next = (((h + delta) % n) + n) % n
          // Walk in the same direction until we land on an enabled row.
          // Bail if everything is disabled (avoid infinite loop).
          for (let i = 0; i < n; i += 1) {
            if (flat[next]?.enabled) return next
            next = (((next + (delta >= 0 ? 1 : -1)) % n) + n) % n
          }
          return next
        }),
      pickCurrent: () => {
        const f = flat[highlight]
        if (f?.enabled) onPick(f.provider.id, f.model)
      },
    }
    return () => {
      if (forwardRef.current) forwardRef.current = null
    }
  }, [forwardRef, flat, highlight, onPick])

  if (flat.length === 0) {
    return (
      <div className="ml-empty">
        {filter
          ? `No model matches "${filter}".`
          : 'No models enabled. Open Settings → Models and enable some.'}
      </div>
    )
  }

  // Group by provider for visual breaks; still address the same flat index.
  type Group = { provider: ProviderEntry; rows: { f: Flat; idx: number }[] }
  const groups: Group[] = []
  flat.forEach((f, idx) => {
    const last = groups[groups.length - 1]
    if (last && last.provider.id === f.provider.id) {
      last.rows.push({ f, idx })
    } else {
      groups.push({ provider: f.provider, rows: [{ f, idx }] })
    }
  })

  return (
    <div className="ml" role="listbox">
      {groups.map((g) => (
        <div key={g.provider.id} className="ml-group">
          <div className="ml-group-head">
            <span className="dot" data-kind={g.provider.kind} />
            {g.provider.name}
          </div>
          {g.rows.map(({ f, idx }) => {
            const isCurrent =
              f.provider.id === currentProviderId && f.model === currentModel
            const isHi = idx === highlight
            const caps = getModelCapabilities(f.provider, f.model)
            return (
              <button
                key={`${f.provider.id}/${f.model}`}
                type="button"
                className={`ml-row ${isHi ? 'highlight' : ''} ${isCurrent ? 'current' : ''} ${f.enabled ? '' : 'disabled'}`}
                onMouseEnter={() => f.enabled && setHighlight(idx)}
                onClick={() => f.enabled && onPick(f.provider.id, f.model)}
                disabled={!f.enabled}
                title={f.enabled ? undefined : 'This model does not support image input'}
              >
                <span className="ml-model">{f.model}</span>
                {caps.vision && <span className="ml-cap-badge" title="Vision"><Icon name="eye" size={13} /></span>}
                {isCurrent && <span className="ml-current-tag">current</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

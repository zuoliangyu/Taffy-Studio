// MCP market browser — lives inside the MCP settings panel. Pick a source
// (official registry or a custom one), search, and install a server. Installing
// builds an McpServerConfig (see lib/mcpMarket) and hands it back to McpPanel,
// which persists it alongside manually-added servers. Remote (HTTP) entries
// install everywhere; local (stdio) entries are gated to desktop / self-hosted.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { McpServerConfig } from '../lib/mcp'
import {
  installAvailable,
  installEntry,
  isInstalled,
  loadSources,
  OFFICIAL_SOURCE,
  saveCustomSources,
  searchCatalog,
  type CatalogEntry,
  type RegistrySource,
} from '../lib/mcpMarket'

interface Props {
  platform: string
  servers: McpServerConfig[]
  onInstall: (cfg: McpServerConfig, connectNow: boolean) => Promise<void>
}

export function McpMarket({ platform, servers, onInstall }: Props) {
  const { t } = useI18n()
  const [sources, setSources] = useState<RegistrySource[]>([])
  const [sourceId, setSourceId] = useState('official')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addingSource, setAddingSource] = useState(false)
  const [target, setTarget] = useState<CatalogEntry | null>(null)
  // Bumped to force a fresh search (source change / explicit submit).
  const [reloadKey, setReloadKey] = useState(0)
  const reqIdRef = useRef(0)

  useEffect(() => {
    loadSources()
      .then(setSources)
      .catch((e) => setError(String(e)))
  }, [])

  const source = sources.find((s) => s.id === sourceId) ?? sources[0]

  const runSearch = useCallback(
    async (more: boolean) => {
      if (!source) return
      const req = ++reqIdRef.current
      setLoading(true)
      setError(null)
      try {
        const page = await searchCatalog(source, query, more ? cursor : undefined)
        if (req !== reqIdRef.current) return // a newer search superseded this one
        setEntries((prev) => (more ? [...prev, ...page.entries] : page.entries))
        setCursor(page.nextCursor)
      } catch (e) {
        if (req === reqIdRef.current) {
          setError(String(e))
          if (!more) setEntries([])
        }
      } finally {
        if (req === reqIdRef.current) setLoading(false)
      }
    },
    // `query` is read live but we only re-search on submit/source change, so it
    // is intentionally excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, cursor],
  )

  // Fresh search whenever the source changes or a search is submitted.
  useEffect(() => {
    if (!source) return
    void runSearch(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, reloadKey, source?.id])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setReloadKey((k) => k + 1)
  }

  async function addSource(label: string, url: string) {
    const custom = sources.filter((s) => s.id !== 'official')
    const next: RegistrySource = { id: crypto.randomUUID(), label: label || url, url }
    const updated = [...custom, next]
    await saveCustomSources(updated)
    setSources([OFFICIAL_SOURCE, ...updated])
    setAddingSource(false)
    setSourceId(next.id)
  }

  async function removeSource(id: string) {
    const custom = sources.filter((s) => s.id !== 'official' && s.id !== id)
    await saveCustomSources(custom)
    setSources([OFFICIAL_SOURCE, ...custom])
    if (sourceId === id) setSourceId('official')
  }

  return (
    <div className="market">
      <p className="muted-small mcp-desc">{t('market.desc')}</p>

      <div className="market-bar">
        <label className="market-source">
          <span className="muted-small">{t('market.source')}</span>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {sourceId !== 'official' && (
          <button
            type="button"
            className="ghost small"
            onClick={() => void removeSource(sourceId)}
          >
            {t('market.removeSource')}
          </button>
        )}
        <button type="button" className="ghost small" onClick={() => setAddingSource(true)}>
          {t('market.addSource')}
        </button>
      </div>

      {addingSource && <AddSourceForm onAdd={addSource} onCancel={() => setAddingSource(false)} />}

      <form className="market-search" onSubmit={submit}>
        <input
          value={query}
          placeholder={t('market.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="ghost small" disabled={loading}>
          {t('market.search')}
        </button>
      </form>

      {error && <div className="mcp-error">{error}</div>}

      {entries.length === 0 && !loading && !error ? (
        <p className="muted-small">{t('market.empty')}</p>
      ) : (
        <div className="market-list">
          {entries.map((e) => (
            <MarketRow
              key={e.id}
              entry={e}
              platform={platform}
              installed={e.installs.some((i) => isInstalled(i, servers))}
              onInstall={() => setTarget(e)}
            />
          ))}
        </div>
      )}

      {loading && <p className="muted-small">{t('market.loading')}</p>}
      {!loading && cursor && (
        <div className="market-foot">
          <button type="button" className="ghost small" onClick={() => void runSearch(true)}>
            {t('market.loadMore')}
          </button>
        </div>
      )}

      {target && (
        <InstallDialog
          entry={target}
          platform={platform}
          onClose={() => setTarget(null)}
          onInstall={async (cfg, connectNow) => {
            await onInstall(cfg, connectNow)
            setTarget(null)
          }}
        />
      )}
    </div>
  )
}

function MarketRow({
  entry,
  platform,
  installed,
  onInstall,
}: {
  entry: CatalogEntry
  platform: string
  installed: boolean
  onInstall: () => void
}) {
  const { t } = useI18n()
  const hasRemote = entry.installs.some((i) => i.transport === 'http')
  const hasLocal = entry.installs.some((i) => i.transport === 'stdio')
  const canInstall = entry.installs.some((i) => installAvailable(i, platform))
  return (
    <div className="market-card">
      <div className="market-card-main">
        <div className="market-card-title">
          <code className="skill-name">{entry.name}</code>
          {entry.version && <span className="market-ver">v{entry.version}</span>}
          {hasRemote && <span className="market-badge remote">{t('market.remote')}</span>}
          {hasLocal && (
            <span className="market-badge local">
              {t('market.local')} · {t('market.desktopOnly')}
            </span>
          )}
          {entry.deprecated && (
            <span className="market-badge deprecated">{t('market.deprecated')}</span>
          )}
        </div>
        {entry.description && <span className="skill-desc">{entry.description}</span>}
        {entry.repositoryUrl && (
          <a
            className="muted-small market-repo"
            href={entry.repositoryUrl}
            target="_blank"
            rel="noreferrer"
          >
            {entry.repositoryUrl}
          </a>
        )}
      </div>
      <button
        type="button"
        className="ghost small"
        disabled={installed || !canInstall}
        title={!canInstall ? t('market.unsupported') : undefined}
        onClick={onInstall}
      >
        {installed ? t('market.installed') : t('market.install')}
      </button>
    </div>
  )
}

function AddSourceForm({
  onAdd,
  onCancel,
}: {
  onAdd: (label: string, url: string) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  return (
    <div className="market-addsource">
      <label className="mcp-field">
        <span>{t('market.sourceLabel')}</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="mcp-field">
        <span>{t('market.sourceUrl')}</span>
        <input
          value={url}
          placeholder={t('market.sourceUrlPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <div className="market-addsource-actions">
        <button type="button" className="ghost small" onClick={onCancel}>
          {t('market.cancel')}
        </button>
        <button
          type="button"
          className="primary small"
          disabled={!url.trim()}
          onClick={() => void onAdd(label.trim(), url.trim())}
        >
          {t('market.add')}
        </button>
      </div>
    </div>
  )
}

function InstallDialog({
  entry,
  platform,
  onClose,
  onInstall,
}: {
  entry: CatalogEntry
  platform: string
  onClose: () => void
  onInstall: (cfg: McpServerConfig, connectNow: boolean) => Promise<void>
}) {
  const { t } = useI18n()
  // Prefer the first installable available on this platform.
  const firstAvail = entry.installs.findIndex((i) => installAvailable(i, platform))
  const [idx, setIdx] = useState(firstAvail >= 0 ? firstAvail : 0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [connectNow, setConnectNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inst = entry.installs[idx]
  const available = inst && installAvailable(inst, platform)
  const missingRequired =
    inst?.inputs.some((i) => i.required && !(values[i.key] ?? i.default ?? '').trim()) ?? false

  async function doInstall() {
    if (!inst) return
    setBusy(true)
    setError(null)
    try {
      await onInstall(installEntry(entry, inst, values), connectNow)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal market-install" onClick={(e) => e.stopPropagation()}>
        <h3>{t('market.installTitle', { name: entry.name })}</h3>

        {entry.installs.length > 1 && (
          <div className="market-install-opts">
            <span className="muted-small">{t('market.pickInstall')}</span>
            {entry.installs.map((i, n) => (
              <label key={n} className="market-opt">
                <input
                  type="radio"
                  name="inst"
                  checked={idx === n}
                  disabled={!installAvailable(i, platform)}
                  onChange={() => {
                    setIdx(n)
                    setValues({})
                  }}
                />
                <span>
                  {i.transport === 'http' ? t('market.remote') : t('market.local')}
                  {i.transport === 'stdio' && ` · ${t('market.desktopOnly')}`}
                </span>
              </label>
            ))}
          </div>
        )}

        {inst && (
          <>
            <div className="market-cmd">
              <span className="muted-small">
                {inst.transport === 'http' ? t('market.willConnect') : t('market.willRun')}
              </span>
              <code>
                {inst.transport === 'http'
                  ? inst.url
                  : [inst.command, ...inst.args].join(' ')}
              </code>
            </div>

            <div className="market-warning">
              {inst.transport === 'http' ? t('market.httpWarning') : t('market.stdioWarning')}
            </div>

            {inst.inputs.length > 0 && (
              <div className="market-inputs">
                <span className="muted-small">{t('market.inputsTitle')}</span>
                {inst.inputs.map((i) => (
                  <label key={i.key} className="mcp-field">
                    <span>
                      {i.key}
                      {i.required && <em className="market-tag req"> · {t('market.required')}</em>}
                      {i.secret && <em className="market-tag sec"> · {t('market.secret')}</em>}
                    </span>
                    <input
                      type={i.secret ? 'password' : 'text'}
                      value={values[i.key] ?? i.default ?? ''}
                      placeholder={i.description}
                      onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            )}

            {!available && <div className="mcp-error">{t('market.unsupported')}</div>}
          </>
        )}

        {error && <div className="mcp-error">{`${t('market.installError')}: ${error}`}</div>}

        <label className="market-connectnow">
          <input
            type="checkbox"
            checked={connectNow}
            onChange={(e) => setConnectNow(e.target.checked)}
          />
          <span>{t('market.connectNow')}</span>
        </label>

        <div className="market-install-actions">
          <button type="button" className="ghost small" onClick={onClose}>
            {t('market.cancel')}
          </button>
          <button
            type="button"
            className="primary small"
            disabled={busy || !available || missingRequired}
            onClick={() => void doInstall()}
          >
            {busy ? t('market.installing') : t('market.doInstall')}
          </button>
        </div>
      </div>
    </div>
  )
}

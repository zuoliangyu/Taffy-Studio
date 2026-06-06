// MCP server manager — lives inside Settings. Two tabs: "Installed" lists the
// configured servers (stdio or remote HTTP), lets you add/edit/connect and
// import a self-authored stdio zip; "Browse market" installs servers from the
// official registry or a custom source. Configs persist in the Store; live
// connections are held in Rust.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import {
  loadMcpServers,
  mcpConnect,
  mcpDisconnect,
  mcpImportZip,
  saveMcpServers,
  type McpServerConfig,
  type McpTool,
  type McpTransport,
} from '../lib/mcp'
import { currentPlatform } from '../lib/mcpMarket'
import { McpMarket } from './McpMarket'
import { Icon } from './Icon'

type Status =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; tools: McpTool[] }
  | { state: 'error'; message: string }

type Tab = 'installed' | 'market'

export function McpPanel() {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('installed')
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [platform, setPlatform] = useState('web')
  const [importErr, setImportErr] = useState<string | null>(null)
  const zipRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadMcpServers().then(setServers).catch(console.error)
    currentPlatform().then(setPlatform).catch(() => {})
  }, [])

  const isDesktop = platform === 'windows' || platform === 'macos' || platform === 'linux'

  function persist(next: McpServerConfig[]) {
    setServers(next)
    void saveMcpServers(next)
  }

  function addServer() {
    const s: McpServerConfig = {
      id: crypto.randomUUID(),
      name: 'New server',
      transport: 'stdio',
      command: '',
      args: [],
      env: [],
      headers: [],
    }
    persist([...servers, s])
    setExpanded(s.id)
  }

  function patch(id: string, p: Partial<McpServerConfig>) {
    persist(servers.map((s) => (s.id === id ? { ...s, ...p } : s)))
  }

  async function remove(id: string) {
    await mcpDisconnect(id).catch(() => {})
    persist(servers.filter((s) => s.id !== id))
    setStatus((m) => {
      const next = { ...m }
      delete next[id]
      return next
    })
  }

  async function connect(s: McpServerConfig) {
    setStatus((m) => ({ ...m, [s.id]: { state: 'connecting' } }))
    try {
      const tools = await mcpConnect(s)
      setStatus((m) => ({ ...m, [s.id]: { state: 'connected', tools } }))
      setExpanded(s.id)
    } catch (e) {
      setStatus((m) => ({ ...m, [s.id]: { state: 'error', message: String(e) } }))
    }
  }

  async function disconnect(s: McpServerConfig) {
    await mcpDisconnect(s.id).catch(() => {})
    setStatus((m) => ({ ...m, [s.id]: { state: 'idle' } }))
  }

  async function onPickZip(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportErr(null)
    try {
      const r = await mcpImportZip(await file.arrayBuffer())
      const s: McpServerConfig = {
        id: crypto.randomUUID(),
        name: r.name,
        transport: 'stdio',
        command: r.command,
        args: r.args,
        env: r.env,
        headers: [],
      }
      persist([...servers, s])
      setExpanded(s.id)
    } catch (err) {
      setImportErr(String(err))
    }
  }

  /** Persist a market-installed server and optionally connect it right away. */
  async function installFromMarket(cfg: McpServerConfig, connectNow: boolean) {
    persist([...servers, cfg])
    if (connectNow) await connect(cfg)
    setTab('installed')
    setExpanded(cfg.id)
  }

  /** Can this config be connected? stdio needs a command, http needs a url. */
  function ready(s: McpServerConfig): boolean {
    return (s.transport ?? 'stdio') === 'http' ? !!s.url?.trim() : !!s.command.trim()
  }

  return (
    <div className="mcp-panel">
      <div className="kb-tabs">
        <button
          type="button"
          className={`kb-tab ${tab === 'installed' ? 'active' : ''}`}
          onClick={() => setTab('installed')}
        >
          {t('mcp.tabInstalled')}
        </button>
        <button
          type="button"
          className={`kb-tab ${tab === 'market' ? 'active' : ''}`}
          onClick={() => setTab('market')}
        >
          {t('mcp.tabMarket')}
        </button>
      </div>

      {tab === 'market' ? (
        <McpMarket platform={platform} servers={servers} onInstall={installFromMarket} />
      ) : (
        <>
          <p className="muted-small mcp-desc">{t('mcp.desc')}</p>

          {servers.length === 0 ? (
            <p className="muted-small">{t('mcp.noServers')}</p>
          ) : (
            <div className="mcp-list">
              {servers.map((s) => {
                const st = status[s.id] ?? { state: 'idle' }
                const connected = st.state === 'connected'
                const isOpen = expanded === s.id
                const transport: McpTransport = s.transport ?? 'stdio'
                return (
                  <div key={s.id} className={`mcp-card ${connected ? 'connected' : ''}`}>
                    <div className="mcp-card-head">
                      <button
                        type="button"
                        className="mcp-card-toggle"
                        onClick={() => setExpanded(isOpen ? null : s.id)}
                        aria-expanded={isOpen}
                      >
                        <span className={`mcp-status-dot ${st.state}`} />
                        <span className="mcp-card-name">{s.name || '(unnamed)'}</span>
                        <span className="mcp-card-meta">
                          {st.state === 'connecting' && t('mcp.connecting')}
                          {st.state === 'connected' && t('mcp.tools', { n: st.tools.length })}
                          {st.state === 'error' && t('mcp.error')}
                          {st.state === 'idle' &&
                            (transport === 'http'
                              ? t('mcp.transportHttp')
                              : t('mcp.disconnected'))}
                        </span>
                      </button>
                      <div className="mcp-card-actions">
                        {connected ? (
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => void disconnect(s)}
                          >
                            {t('mcp.disconnect')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => void connect(s)}
                            disabled={st.state === 'connecting' || !ready(s)}
                          >
                            {t('mcp.connect')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-only destructive-btn"
                          onClick={() => void remove(s.id)}
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="mcp-card-body">
                        <label className="mcp-field">
                          <span>{t('mcp.name')}</span>
                          <input
                            value={s.name}
                            onChange={(e) => patch(s.id, { name: e.target.value })}
                          />
                        </label>
                        <label className="mcp-field">
                          <span>{t('mcp.transport')}</span>
                          <select
                            value={transport}
                            onChange={(e) =>
                              patch(s.id, { transport: e.target.value as McpTransport })
                            }
                          >
                            <option value="stdio">{t('mcp.transportStdio')}</option>
                            <option value="http">{t('mcp.transportHttp')}</option>
                          </select>
                        </label>

                        {transport === 'http' ? (
                          <>
                            <label className="mcp-field">
                              <span>{t('mcp.url')}</span>
                              <input
                                value={s.url ?? ''}
                                placeholder={t('mcp.urlPlaceholder')}
                                onChange={(e) => patch(s.id, { url: e.target.value })}
                              />
                            </label>
                            <label className="mcp-field">
                              <span>{t('mcp.headers')}</span>
                              <textarea
                                rows={2}
                                value={(s.headers ?? []).join('\n')}
                                placeholder={t('mcp.headersPlaceholder')}
                                onChange={(e) =>
                                  patch(s.id, {
                                    headers: e.target.value
                                      .split('\n')
                                      .map((x) => x.trim())
                                      .filter(Boolean),
                                  })
                                }
                              />
                            </label>
                          </>
                        ) : (
                          <>
                            <label className="mcp-field">
                              <span>{t('mcp.command')}</span>
                              <input
                                value={s.command}
                                placeholder={t('mcp.commandPlaceholder')}
                                onChange={(e) => patch(s.id, { command: e.target.value })}
                              />
                            </label>
                            <label className="mcp-field">
                              <span>{t('mcp.args')}</span>
                              <textarea
                                rows={3}
                                value={s.args.join('\n')}
                                placeholder={t('mcp.argsPlaceholder')}
                                onChange={(e) =>
                                  patch(s.id, {
                                    args: e.target.value
                                      .split('\n')
                                      .filter((x) => x.length > 0),
                                  })
                                }
                              />
                            </label>
                            <label className="mcp-field">
                              <span>{t('mcp.env')}</span>
                              <textarea
                                rows={2}
                                value={s.env.join('\n')}
                                placeholder="API_KEY=…"
                                onChange={(e) =>
                                  patch(s.id, {
                                    env: e.target.value
                                      .split('\n')
                                      .map((x) => x.trim())
                                      .filter(Boolean),
                                  })
                                }
                              />
                            </label>
                          </>
                        )}

                        {st.state === 'error' && <div className="mcp-error">{st.message}</div>}
                        {st.state === 'connected' && st.tools.length > 0 && (
                          <div className="mcp-tools">
                            {st.tools.map((tool) => (
                              <div key={tool.name} className="mcp-tool">
                                <code className="mcp-tool-name">{tool.name}</code>
                                {tool.description && (
                                  <span className="mcp-tool-desc">{tool.description}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {importErr && <div className="mcp-error">{importErr}</div>}

          <div className="mcp-foot mcp-foot-split">
            {isDesktop && (
              <div className="mcp-import">
                <input
                  ref={zipRef}
                  type="file"
                  accept=".zip"
                  style={{ display: 'none' }}
                  onChange={onPickZip}
                />
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => zipRef.current?.click()}
                  title={t('mcp.importZipHint')}
                >
                  {t('mcp.importZip')}
                </button>
              </div>
            )}
            <button type="button" className="ghost small" onClick={addServer}>
              {t('mcp.add')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

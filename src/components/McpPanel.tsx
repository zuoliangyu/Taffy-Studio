// MCP server manager — lives inside Settings. Add/edit stdio server configs,
// connect/disconnect, and inspect the tools each one exposes. Configs persist
// in the Store; live connections are held in Rust.
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import {
  loadMcpServers,
  mcpConnect,
  mcpDisconnect,
  saveMcpServers,
  type McpServerConfig,
  type McpTool,
} from '../lib/mcp'

type Status =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; tools: McpTool[] }
  | { state: 'error'; message: string }

export function McpPanel() {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    loadMcpServers().then(setServers).catch(console.error)
  }, [])

  function persist(next: McpServerConfig[]) {
    setServers(next)
    void saveMcpServers(next)
  }

  function addServer() {
    const s: McpServerConfig = {
      id: crypto.randomUUID(),
      name: 'New server',
      command: '',
      args: [],
      env: [],
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

  return (
    <div className="mcp-panel">
      <p className="muted-small mcp-desc">{t('mcp.desc')}</p>

      {servers.length === 0 ? (
        <p className="muted-small">{t('mcp.noServers')}</p>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => {
            const st = status[s.id] ?? { state: 'idle' }
            const connected = st.state === 'connected'
            const isOpen = expanded === s.id
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
                      {st.state === 'connected' &&
                        t('mcp.tools', { n: st.tools.length })}
                      {st.state === 'error' && t('mcp.error')}
                      {st.state === 'idle' && t('mcp.disconnected')}
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
                        disabled={st.state === 'connecting' || !s.command.trim()}
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
                      🗑
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
                            args: e.target.value.split('\n').map((x) => x).filter((x) => x.length > 0),
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
                            env: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean),
                          })
                        }
                      />
                    </label>

                    {st.state === 'error' && (
                      <div className="mcp-error">{st.message}</div>
                    )}
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

      <div className="mcp-foot">
        <button type="button" className="ghost small" onClick={addServer}>
          {t('mcp.add')}
        </button>
      </div>
    </div>
  )
}

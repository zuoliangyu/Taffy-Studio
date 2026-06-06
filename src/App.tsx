import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatPanel } from './components/ChatPanel'
import { ConvoMenu } from './components/ConvoMenu'
import { SearchPalette } from './components/SearchPalette'
import { SettingsPanel } from './components/SettingsPanel'
import { TemplatePicker } from './components/TemplatePicker'
import { Icon } from './components/Icon'
import logoUrl from './assets/logo.png'
import {
  createConversation,
  deleteConversation,
  initDb,
  listConversations,
  updateConversationPinned,
  updateConversationTitle,
  type Conversation,
} from './lib/db'
import { getPlatform } from './lib/ipc'
import { loadSettings, getProvider, type AppSettings } from './lib/settings'
import type { AssistantTemplate } from './lib/templates'
import { useI18n } from './i18n'

const MOBILE_BREAKPOINT = 760

interface MenuState {
  convoId: string
  x: number
  y: number
}

export default function App() {
  const { t } = useI18n()
  const [platform, setPlatform] = useState('…')
  const [convos, setConvos] = useState<Conversation[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingTitle, setRenamingTitle] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ;(async () => {
      setPlatform(await getPlatform())
      await initDb()
      const list = await listConversations()
      setConvos(list)
      if (list.length > 0) setActive(list[0]!.id)
      setSettings(await loadSettings())
    })().catch(console.error)
  }, [])

  // Re-establish MCP connections on launch (they live in the Rust process and
  // are lost on restart). Fire-and-forget: a misconfigured server just stays
  // disconnected and surfaces in Settings → MCP. Only servers with a command
  // are attempted.
  useEffect(() => {
    ;(async () => {
      const { loadMcpServers, mcpConnect } = await import('./lib/mcp')
      const servers = await loadMcpServers()
      await Promise.allSettled(
        servers
          .filter((s) => s.command.trim().length > 0)
          .map((s) => mcpConnect(s)),
      )
    })().catch(console.error)
  }, [])

  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Cmd/Ctrl+K → toggle global search palette. Bound at the document level
  // so it works from anywhere — including while a textarea has focus —
  // because preventDefault catches it before the textarea sees Ctrl+K (which
  // some browsers map to "delete to end of line").
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Auto-focus the rename input the moment we enter edit mode.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  async function onNewConvo() {
    const c = await createConversation(`Conversation ${convos.length + 1}`)
    setConvos((cs) => [c, ...cs])
    setActive(c.id)
    if (isMobile) setDrawerOpen(false)
  }

  async function onNewConvoFromTemplate(t: AssistantTemplate) {
    // Title falls back to the template name + index — easier to identify
    // than "Conversation N" once a user has several presets in flight.
    const title = `${t.name} ${convos.filter((c) => c.title.startsWith(t.name)).length + 1}`
    const c = await createConversation(title, {
      providerId: t.providerId ?? null,
      model: t.model ?? null,
      temperature: t.temperature ?? null,
      systemPrompt: t.systemPrompt ?? null,
    })
    setConvos((cs) => [c, ...cs])
    setActive(c.id)
    setTemplatePickerOpen(false)
    if (isMobile) setDrawerOpen(false)
  }

  function onPickConvo(id: string) {
    if (renamingId === id) return // clicks on the rename input shouldn't re-select
    setActive(id)
    if (isMobile) setDrawerOpen(false)
  }

  async function onCloseSettings() {
    setSettingsOpen(false)
    // Reload settings so the topbar summary chip reflects any changes.
    setSettings(await loadSettings())
  }

  function openMenuForRow(convoId: string, ev: React.MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    setMenu({ convoId, x: ev.clientX, y: ev.clientY })
  }

  function startRename(convoId: string) {
    const c = convos.find((x) => x.id === convoId)
    if (!c) return
    setRenamingId(convoId)
    setRenamingTitle(c.title)
    setMenu(null)
  }

  async function commitRename() {
    if (!renamingId) return
    const id = renamingId
    const next = renamingTitle.trim()
    setRenamingId(null)
    setRenamingTitle('')
    const current = convos.find((c) => c.id === id)
    if (!current || next.length === 0 || next === current.title) return
    await updateConversationTitle(id, next)
    setConvos((cs) =>
      cs.map((c) => (c.id === id ? { ...c, title: next, updated_at: Date.now() } : c)),
    )
  }

  function cancelRename() {
    setRenamingId(null)
    setRenamingTitle('')
  }

  async function onTogglePin(convoId: string) {
    const c = convos.find((x) => x.id === convoId)
    if (!c) return
    const nextPinned = (c.pinned ?? 0) ? 0 : 1
    await updateConversationPinned(convoId, !!nextPinned)
    // Re-sort by re-fetching: order depends on pinned DESC + updated_at DESC
    // and re-running the SQL keeps us honest with the DB.
    const list = await listConversations()
    setConvos(list)
    setMenu(null)
  }

  async function onDelete(convoId: string) {
    await deleteConversation(convoId)
    const remaining = convos.filter((c) => c.id !== convoId)
    setConvos(remaining)
    if (active === convoId) {
      setActive(remaining[0]?.id ?? null)
    }
    setMenu(null)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return convos
    return convos.filter((c) => c.title.toLowerCase().includes(q))
  }, [convos, query])

  const sidebarVisible = !isMobile || drawerOpen
  const menuConvo = menu ? convos.find((c) => c.id === menu.convoId) ?? null : null

  return (
    <div className={`app-shell ${isMobile ? 'is-mobile' : ''}`}>
      <div className="app-shell-inner">
        {/* Top bar — glass shell */}
        <header className="topbar surface-shell no-select">
          {isMobile && (
            <button
              type="button"
              className="ghost icon"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('topbar.openConvos')}
            >
              <Icon name="menu" size={20} />
            </button>
          )}

          <div className="topbar-brand">
            <div className="brand-mark">
              <img src={logoUrl} alt="Taffy Studio" />
            </div>
            <div className="brand-text">
              <div className="brand-title">Taffy Studio</div>
              <div className="brand-sub">{t('app.subtitle')}</div>
            </div>
          </div>

          {!isMobile && settings && (() => {
            const p = getProvider(settings)
            if (!p) return null
            return (
              <div className="topbar-summary toolbar-chip-strong">
                <div className="summary-icon"><Icon name="zap" size={16} /></div>
                <div className="summary-text">
                  <div className="summary-label">{t('app.provider')}</div>
                  <div className="summary-value">
                    {p.name} · {p.defaultModel || t('app.noModel')}
                  </div>
                </div>
              </div>
            )
          })()}

          <div className="topbar-spacer" />

          <div className="topbar-actions">
            {!isMobile && (
              <span className="platform-pill" title={t('topbar.platform', { platform })}>
                {platform}
              </span>
            )}
            <button
              type="button"
              className="ghost icon"
              onClick={() => setSearchOpen(true)}
              aria-label={t('topbar.search')}
              title={t('topbar.search')}
            >
              <Icon name="search" size={19} />
            </button>
            <button
              type="button"
              className="ghost icon"
              onClick={() => setSettingsOpen(true)}
              aria-label={t('topbar.settings')}
            >
              <Icon name="settings" size={19} />
            </button>
          </div>
        </header>

        <div className="workspace">
          <aside className={`sidebar surface-sidebar ${sidebarVisible ? 'open' : ''}`}>
            <div className="sidebar-head">
              <span className="title">{t('sidebar.conversations')}</span>
              {isMobile && (
                <>
                  <span className="platform-pill">{platform}</span>
                  <button
                    type="button"
                    className="ghost icon close"
                    onClick={() => setDrawerOpen(false)}
                    aria-label={t('sidebar.closeDrawer')}
                    style={{ marginLeft: 4 }}
                  >
                    <Icon name="x" size={18} />
                  </button>
                </>
              )}
            </div>

            <div className="sidebar-actions">
              <div className="new-chat-group">
                <button className="new-chat-main" onClick={onNewConvo}>
                  <Icon name="plus" size={17} /> {t('sidebar.newChat')}
                </button>
                <button
                  type="button"
                  className="new-chat-more"
                  onClick={() => setTemplatePickerOpen((o) => !o)}
                  title={t('sidebar.templateMenu')}
                  aria-label={t('sidebar.templateMenu')}
                  aria-expanded={templatePickerOpen}
                >
                  <Icon name="chevron-down" size={16} />
                </button>
                {templatePickerOpen && settings && (
                  <TemplatePicker
                    templates={settings.templates ?? []}
                    onPickBlank={() => {
                      setTemplatePickerOpen(false)
                      void onNewConvo()
                    }}
                    onPick={(t) => void onNewConvoFromTemplate(t)}
                    onManage={() => {
                      setTemplatePickerOpen(false)
                      setSettingsOpen(true)
                    }}
                    onClose={() => setTemplatePickerOpen(false)}
                  />
                )}
              </div>
            </div>

            <div className="convo-search">
              <input
                type="search"
                value={query}
                placeholder={t('sidebar.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('sidebar.searchPlaceholder')}
              />
              {query && (
                <button
                  type="button"
                  className="ghost icon clear"
                  onClick={() => setQuery('')}
                  aria-label={t('sidebar.clearSearch')}
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            <ul className="convo-list">
              {filtered.length === 0 && (
                <li className="empty-hint">
                  {query ? t('sidebar.noMatch') : t('sidebar.empty')}
                </li>
              )}
              {filtered.map((c) => {
                const isActive = c.id === active
                const isRenaming = c.id === renamingId
                const pinned = !!(c.pinned ?? 0)
                return (
                  <li
                    key={c.id}
                    className={`convo-row${isActive ? ' active' : ''}${pinned ? ' pinned' : ''}`}
                    onClick={() => onPickConvo(c.id)}
                    onContextMenu={(e) => openMenuForRow(c.id, e)}
                  >
                    {pinned && <span className="pin-dot" aria-label="Pinned" title="Pinned"><Icon name="pin" size={13} filled /></span>}
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        className="rename-input"
                        value={renamingTitle}
                        onChange={(e) => setRenamingTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => {
                          void commitRename()
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelRename()
                          }
                        }}
                      />
                    ) : (
                      <span className="title">{c.title}</span>
                    )}
                    <span className="ts">
                      {new Date(c.updated_at).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      className="ghost icon more"
                      aria-label="Row actions"
                      title="Actions"
                      onClick={(e) => openMenuForRow(c.id, e)}
                    >
                      <Icon name="more" size={18} />
                    </button>
                  </li>
                )
              })}
            </ul>

            {isMobile && (
              <div className="sidebar-foot">
                <button className="ghost full settings-full" onClick={() => setSettingsOpen(true)}>
                  <Icon name="settings" size={17} /> {t('sidebar.settings')}
                </button>
              </div>
            )}
          </aside>

          {isMobile && drawerOpen && (
            <div className="scrim" onClick={() => setDrawerOpen(false)} />
          )}

          <main className="main mode-stack">
            <div className="main-inner mode-stage" key={active ?? 'empty'}>
              <ChatPanel
                conversation={convos.find((c) => c.id === active) ?? null}
                onTitleChanged={(id, title) => {
                  setConvos((cs) =>
                    cs.map((c) => (c.id === id ? { ...c, title } : c)),
                  )
                }}
                onModelChanged={(id, providerId, model) => {
                  setConvos((cs) =>
                    cs.map((c) =>
                      c.id === id ? { ...c, provider_id: providerId, model } : c,
                    ),
                  )
                }}
                onTemperatureChanged={(id, temperature) => {
                  setConvos((cs) =>
                    cs.map((c) => (c.id === id ? { ...c, temperature } : c)),
                  )
                }}
                onMaxTokensChanged={(id, max_tokens) => {
                  setConvos((cs) =>
                    cs.map((c) => (c.id === id ? { ...c, max_tokens } : c)),
                  )
                }}
                onSystemPromptChanged={(id, system_prompt) => {
                  setConvos((cs) =>
                    cs.map((c) => (c.id === id ? { ...c, system_prompt } : c)),
                  )
                }}
              />
            </div>
          </main>
        </div>
      </div>

      {menu && menuConvo && (
        <ConvoMenu
          x={menu.x}
          y={menu.y}
          pinned={!!(menuConvo.pinned ?? 0)}
          onRename={() => startRename(menu.convoId)}
          onPin={() => void onTogglePin(menu.convoId)}
          onDelete={() => void onDelete(menu.convoId)}
          onClose={() => setMenu(null)}
        />
      )}

      <SettingsPanel open={settingsOpen} onClose={onCloseSettings} />

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPickConversation={(convoId) => {
          setActive(convoId)
          if (isMobile) setDrawerOpen(false)
        }}
      />
    </div>
  )
}

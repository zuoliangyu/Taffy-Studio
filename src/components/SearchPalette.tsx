// Global search palette — Ctrl/Cmd+K from anywhere opens it; it queries the
// FTS5 index over messages.content and lets the user jump to the hit's
// conversation. Highlighting is server-rendered via SQLite snippet(); we
// HTML-escape the surrounding text in db.ts before wrapping the marker
// bytes with <b>…</b>, so dangerouslySetInnerHTML is safe here.
import { useEffect, useMemo, useRef, useState } from 'react'
import { searchMessages, type SearchHit } from '../lib/db'

interface Props {
  open: boolean
  onClose: () => void
  /** Switch the chat view to the picked conversation. */
  onPickConversation: (conversationId: string, messageId?: string) => void
}

export function SearchPalette({ open, onClose, onPickConversation }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [highlight, setHighlight] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Token so a stale query's response can't overwrite a fresh one's results.
  const queryToken = useRef(0)

  // Reset when the modal opens; auto-focus the input.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setHighlight(0)
    setError(null)
    // Defer focus past the modal mount so the click that opened us doesn't
    // race the input.
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  // Debounced search: wait 150ms after the user stops typing.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length === 0) {
      setHits([])
      setBusy(false)
      setError(null)
      return
    }
    const myToken = ++queryToken.current
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const results = await searchMessages(q, 50)
        if (queryToken.current !== myToken) return // stale
        setHits(results)
        setHighlight(0)
        setError(null)
      } catch (e) {
        if (queryToken.current !== myToken) return
        setError(String(e))
      } finally {
        if (queryToken.current === myToken) setBusy(false)
      }
    }, 150)
    return () => clearTimeout(t)
  }, [query, open])

  // Esc closes; ArrowUp/Down navigates; Enter picks.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (hits.length === 0 ? 0 : (h + 1) % hits.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (hits.length === 0 ? 0 : (h - 1 + hits.length) % hits.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const h = hits[highlight]
        if (h) {
          onPickConversation(h.conversation_id, h.message_id)
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, hits, highlight, onPickConversation, onClose])

  // Keep the highlighted row scrolled into view as the user arrows.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-search-idx="${highlight}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  // Group hits by conversation for visual hierarchy; keep the global index
  // so arrow-key navigation works against a single flat list.
  const groups = useMemo(() => {
    const out: Array<{ id: string; title: string; rows: { hit: SearchHit; idx: number }[] }> = []
    hits.forEach((hit, idx) => {
      const last = out[out.length - 1]
      if (last && last.id === hit.conversation_id) {
        last.rows.push({ hit, idx })
      } else {
        out.push({
          id: hit.conversation_id,
          title: hit.conversation_title,
          rows: [{ hit, idx }],
        })
      }
    })
    return out
  }, [hits])

  if (!open) return null

  return (
    <div className="modal-backdrop search-backdrop" onClick={onClose}>
      <div
        className="search-palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search messages"
      >
        <div className="search-input-row">
          <span className="search-icon" aria-hidden="true">🔍</span>
          <input
            ref={inputRef}
            type="search"
            className="search-input"
            placeholder="Search messages… (trailing * for prefix)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {busy && <span className="search-busy">…</span>}
          <button
            type="button"
            className="ghost icon"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="search-results" ref={listRef}>
          {error && <div className="storage-error">{error}</div>}
          {!error && query.trim().length === 0 && (
            <div className="search-empty muted-small">
              Type to search every message across every conversation. Cmd/Ctrl+K
              toggles this anywhere.
            </div>
          )}
          {!error && query.trim().length > 0 && hits.length === 0 && !busy && (
            <div className="search-empty muted-small">No matches.</div>
          )}
          {groups.map((g) => (
            <div className="search-group" key={g.id}>
              <div className="search-group-head">{g.title}</div>
              {g.rows.map(({ hit, idx }) => (
                <button
                  key={hit.message_id}
                  type="button"
                  data-search-idx={idx}
                  className={`search-hit ${idx === highlight ? 'highlight' : ''}`}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => {
                    onPickConversation(hit.conversation_id, hit.message_id)
                    onClose()
                  }}
                >
                  <span className="search-hit-role">{hit.role}</span>
                  <span
                    className="search-excerpt"
                    // db.ts already HTML-escaped the excerpt; only <b> tags
                    // around match terms are intentional markup.
                    dangerouslySetInnerHTML={{ __html: hit.excerpt }}
                  />
                  <span className="search-hit-date">
                    {new Date(hit.created_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Dropdown shown when the user clicks the ▾ next to "+ New chat". Lists
// every AssistantTemplate plus a "Blank" option (= the original 1-click
// behavior). Picking a template hands its override fields up to the parent,
// which calls db.createConversation(title, init) with them.
import { useEffect, useRef } from 'react'
import type { AssistantTemplate } from '../lib/templates'

interface Props {
  templates: AssistantTemplate[]
  /** Pick "Blank" — caller creates a default new conversation. */
  onPickBlank: () => void
  /** Pick a template — caller creates a conversation seeded from it. */
  onPick: (t: AssistantTemplate) => void
  /** Open Settings on the Templates section so the user can edit / add. */
  onManage: () => void
  onClose: () => void
}

export function TemplatePicker({
  templates,
  onPickBlank,
  onPick,
  onManage,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const el = ref.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        onClose()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} className="template-picker" role="menu">
      <button
        type="button"
        role="menuitem"
        className="template-row template-row-blank"
        onClick={onPickBlank}
      >
        <span className="template-name">＋ Blank chat</span>
        <span className="template-desc">Use global default provider / model.</span>
      </button>
      {templates.length > 0 && <div className="template-sep" />}
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitem"
          className="template-row"
          onClick={() => onPick(t)}
          title={t.systemPrompt ?? undefined}
        >
          <span className="template-name">{t.name}</span>
          {t.description && (
            <span className="template-desc">{t.description}</span>
          )}
        </button>
      ))}
      <div className="template-sep" />
      <button
        type="button"
        role="menuitem"
        className="template-row template-row-manage"
        onClick={onManage}
      >
        <span className="template-name">⚙ Manage templates…</span>
      </button>
    </div>
  )
}

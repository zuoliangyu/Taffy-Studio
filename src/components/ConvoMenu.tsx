// Floating dropdown for a conversation row: rename / pin / delete.
//
// Anchored at the user's pointer (right-click) or the ⋯ button's click point.
// Lives at the App level so only one menu is open at a time. Delete asks for
// a second click in-place instead of using window.confirm() — that's the
// pattern we already use for the Storage Reset flow.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface Props {
  /** Viewport coords (px) the menu should snap near. */
  x: number
  y: number
  pinned: boolean
  onRename: () => void
  onPin: () => void
  onDelete: () => void
  onClose: () => void
}

export function ConvoMenu({ x, y, pinned, onRename, onPin, onDelete, onClose }: Props) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement | null>(null)
  const [confirming, setConfirming] = useState(false)
  // We re-pin the menu inside the viewport after first paint — measuring its
  // own size is the only way to know how much room to claim near a right edge.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(8, x), vw - rect.width - 8)
    const top = Math.min(Math.max(8, y), vh - rect.height - 8)
    setPos({ left, top })
  }, [x, y])

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
    <div
      ref={ref}
      className="convo-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!confirming ? (
        <>
          <button type="button" role="menuitem" onClick={onRename}>
            <Icon name="pencil" size={15} /> {t('menu.rename')}
          </button>
          <button type="button" role="menuitem" onClick={onPin}>
            <Icon name="pin" size={15} filled={pinned} /> {pinned ? t('menu.unpin') : t('menu.pin')}
          </button>
          <div className="convo-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="destructive"
            onClick={() => setConfirming(true)}
          >
            <Icon name="trash" size={15} /> {t('menu.deleteEllipsis')}
          </button>
        </>
      ) : (
        <>
          <div className="convo-menu-confirm-hint">{t('menu.confirmTitle')}</div>
          <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" role="menuitem" className="destructive" onClick={onDelete}>
            {t('menu.confirmYes')}
          </button>
        </>
      )}
    </div>
  )
}

// Pending attachments shown above the composer. Image chips render an actual
// thumbnail; non-image files render a generic icon + size. Each chip has an ×
// remove button. The "non-image" path is kept for visual completeness but
// such files are skipped on the wire (see Rust image_attachments filter).
//
// Implementation note: the remove control is a <span role="button"> rather
// than a real <button>, because our global `button {}` rule has aggressive
// padding/shadow that's hard to selectively undo. Using a span sidesteps
// the cascade entirely.
import { attachmentToDataUrl, formatBytes } from '../lib/attachments'
import type { Attachment } from '../lib/llm'

interface Props {
  items: Attachment[]
  onRemove: (id: string) => void
  /** Smaller, read-only variant used inside an already-sent message bubble. */
  variant?: 'composer' | 'bubble'
  /** Click handler for full-size preview. */
  onPreview?: (a: Attachment) => void
}

export function AttachmentChips({ items, onRemove, variant = 'composer', onPreview }: Props) {
  if (items.length === 0) return null
  return (
    <div className={`att-strip att-strip-${variant}`}>
      {items.map((a) => (
        <Chip
          key={a.id}
          a={a}
          variant={variant}
          onRemove={variant === 'composer' ? () => onRemove(a.id) : undefined}
          onPreview={onPreview}
        />
      ))}
    </div>
  )
}

function RemoveControl({ onClick }: { onClick: () => void }) {
  return (
    <span
      className="att-remove"
      role="button"
      tabIndex={0}
      aria-label="Remove attachment"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      ×
    </span>
  )
}

function Chip({
  a,
  variant,
  onRemove,
  onPreview,
}: {
  a: Attachment
  variant: 'composer' | 'bubble'
  onRemove?: () => void
  onPreview?: (a: Attachment) => void
}) {
  const isImage = a.type === 'image' && a.mime.startsWith('image/')

  if (isImage) {
    return (
      <div className={`att-chip att-image att-${variant}`}>
        <img
          src={attachmentToDataUrl(a)}
          alt={a.name}
          onClick={() => onPreview?.(a)}
          role={onPreview ? 'button' : undefined}
          title={`${a.name} · ${formatBytes(a.size)}`}
        />
        {onRemove && <RemoveControl onClick={onRemove} />}
      </div>
    )
  }

  return (
    <div
      className={`att-chip att-file att-${variant}`}
      title={`${a.name} · ${formatBytes(a.size)} · file attachments are not yet sent to the model`}
    >
      <span className="att-icon">📄</span>
      <span className="att-info">
        <span className="att-name">{a.name}</span>
        <span className="att-meta">{formatBytes(a.size)} · skipped on send</span>
      </span>
      {onRemove && <RemoveControl onClick={onRemove} />}
    </div>
  )
}

// Knowledge base manager — lives inside Settings. Create KBs (each bound to an
// embedding provider+model), add text or files, and inspect indexed documents.
// Retrieval at chat time is wired in ChatPanel via a per-conversation KB chip.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { getModelCapabilities } from '../lib/capabilities'
import { extractText, isExtractable } from '../lib/doctext'
import {
  addDocument,
  countChunks,
  createKnowledgeBase,
  deleteDocument,
  deleteKnowledgeBase,
  listDocuments,
  listKnowledgeBases,
  type DocSummary,
  type KnowledgeBase,
} from '../lib/rag'
import type { AppSettings } from '../lib/settings'
import { Icon } from './Icon'

export function KnowledgePanel({ settings }: { settings: AppSettings }) {
  const { t } = useI18n()
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [active, setActive] = useState<string | null>(null)

  async function refresh() {
    const list = await listKnowledgeBases()
    setBases(list)
    if (list.length > 0 && !list.some((b) => b.id === active)) {
      setActive(list[0]!.id)
    }
  }

  useEffect(() => {
    refresh().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onCreate() {
    // Seed with the default provider + first embedding-ish model.
    const provider = settings.providers.find((p) => p.id === settings.defaultProviderId) ?? settings.providers[0]
    const embedModel =
      provider?.enabledModels.find((m) => getModelCapabilities(provider, m).embedding) ??
      provider?.enabledModels[0] ??
      null
    const kb = await createKnowledgeBase('Knowledge base', provider?.id ?? null, embedModel)
    await refresh()
    setActive(kb.id)
  }

  const activeKb = bases.find((b) => b.id === active) ?? null

  return (
    <div className="kb-panel">
      <p className="muted-small">{t('kb.desc')}</p>

      {bases.length === 0 ? (
        <p className="muted-small">{t('kb.empty')}</p>
      ) : (
        <div className="kb-tabs">
          {bases.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`kb-tab ${b.id === active ? 'active' : ''}`}
              onClick={() => setActive(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {activeKb && (
        <KbEditor
          kb={activeKb}
          settings={settings}
          onChanged={refresh}
          onDeleted={() => {
            setActive(null)
            void refresh()
          }}
        />
      )}

      <div className="kb-foot">
        <button type="button" className="ghost small" onClick={() => void onCreate()}>
          {t('kb.create')}
        </button>
      </div>
    </div>
  )
}

function KbEditor({
  kb,
  settings,
  onChanged,
  onDeleted,
}: {
  kb: KnowledgeBase
  settings: AppSettings
  onChanged: () => Promise<void>
  onDeleted: () => void
}) {
  const { t } = useI18n()
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [chunks, setChunks] = useState(0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function reloadDocs() {
    setDocs(await listDocuments(kb.id))
    setChunks(await countChunks(kb.id))
  }

  useEffect(() => {
    reloadDocs().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.id])

  const provider = settings.providers.find((p) => p.id === kb.provider_id)

  async function index(source: string, body: string) {
    if (!body.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addDocument(settings, kb, source, body)
      await reloadDocs()
      await onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onAddText() {
    const body = text
    setText('')
    await index('text note', body)
  }

  async function onFiles(files: FileList) {
    for (const f of Array.from(files)) {
      if (!isExtractable(f)) {
        setError(`Unsupported file type: ${f.name}`)
        continue
      }
      const body = await extractText(f)
      if (body) await index(f.name, body)
    }
  }

  return (
    <div className="kb-editor">
      <div className="kb-editor-head">
        <input
          className="kb-name"
          value={kb.name}
          onChange={async (e) => {
            const { updateKnowledgeBase } = await import('../lib/rag')
            await updateKnowledgeBase(kb.id, { name: e.target.value })
            await onChanged()
          }}
        />
        <span className="kb-meta">{t('kb.chunks', { n: chunks })}</span>
        <button
          type="button"
          className="icon-only destructive-btn"
          title={t('kb.delete')}
          aria-label={t('kb.delete')}
          onClick={async () => {
            await deleteKnowledgeBase(kb.id)
            onDeleted()
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>

      <div className="kb-editor-row">
        <label className="kb-field">
          <span>{t('kb.embedModel')}</span>
          <div className="kb-embed-pick">
            <select
              value={kb.provider_id ?? ''}
              onChange={async (e) => {
                const { updateKnowledgeBase } = await import('../lib/rag')
                await updateKnowledgeBase(kb.id, {
                  provider_id: e.target.value || null,
                  embed_model: null,
                })
                await onChanged()
              }}
            >
              <option value="">—</option>
              {settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={kb.embed_model ?? ''}
              disabled={!provider}
              onChange={async (e) => {
                const { updateKnowledgeBase } = await import('../lib/rag')
                await updateKnowledgeBase(kb.id, { embed_model: e.target.value || null })
                await onChanged()
              }}
            >
              <option value="">{t('kb.pickEmbed')}</option>
              {(provider?.enabledModels ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>

      <div className="kb-add">
        <textarea
          rows={3}
          placeholder={t('kb.textPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="kb-add-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => void onAddText()}
            disabled={busy || !text.trim() || !kb.embed_model}
          >
            {busy ? t('kb.indexing') : t('kb.addText')}
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => fileRef.current?.click()}
            disabled={busy || !kb.embed_model}
          >
            {t('kb.addFile')}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept=".pdf,.txt,.md,.markdown,.csv,.json,.html,.xml,.log"
            onChange={(e) => {
              if (e.target.files) void onFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {error && <div className="kb-error">{error}</div>}

      {docs.length > 0 && (
        <ul className="kb-docs">
          {docs.map((d) => (
            <li key={d.doc_id} className="kb-doc">
              <span className="kb-doc-name">{d.source}</span>
              <span className="kb-doc-meta">{t('kb.chunks', { n: d.chunks })}</span>
              <button
                type="button"
                className="icon-only destructive-btn"
                title={t('kb.deleteDoc')}
                aria-label={t('kb.deleteDoc')}
                onClick={async () => {
                  await deleteDocument(d.doc_id)
                  await reloadDocs()
                  await onChanged()
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

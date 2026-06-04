// The safety net for users when a future migration breaks something:
// see the DB path, see the auto-backups Rust takes on each startup, snapshot
// on demand, open the folder, or nuke + rebuild from scratch (still keeping
// the backups around).
//
// Designed to live inside SettingsPanel rather than as its own modal — the
// API key dialog is the natural place to also expose storage controls.
import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { formatBytes } from '../lib/attachments'
import {
  exportConversationsToJson,
  importConversationsFromJson,
  type ImportSummary,
} from '../lib/db'
import { fsReadTextAbs, fsWriteTextAbs } from '../lib/ipc'
import {
  backupNow,
  openConfigDir,
  resetDatabase,
  storageInfo,
  type BackupInfo,
  type StorageInfo,
} from '../lib/storage'

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// On desktop we save/open via the native dialog + Rust file I/O; in the browser
// there is no filesystem, so export becomes a Blob download and import a hidden
// <input type=file>. The data itself round-trips through the same backend
// export/import endpoints either way.
const IS_TAURI = __IS_TAURI__

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Prompt for a JSON file and resolve its text, or null if the user cancels. */
function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    }
    // Fires when the picker is dismissed without a selection (modern browsers).
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export function StoragePanel() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null)

  const refresh = useCallback(async () => {
    // storageInfo (DB path, on-disk backups) is a desktop-only concept; the web
    // shell stores everything server-side and has no local file surface.
    if (!IS_TAURI) return
    try {
      setInfo(await storageInfo())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function onBackupNow() {
    setBusy('backup')
    setError(null)
    try {
      await backupNow()
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onReset() {
    setBusy('reset')
    setError(null)
    try {
      await resetDatabase()
      setConfirmingReset(false)
      // Force a hard reload so all in-memory state (db handle, settings) is
      // re-fetched against the fresh schema.
      window.location.reload()
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }

  async function onOpenFolder() {
    setBusy('open')
    setError(null)
    try {
      await openConfigDir()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onExport() {
    setBusy('export')
    setError(null)
    try {
      // Build the JSON first so a dialog cancel doesn't leave us mid-export.
      const json = await exportConversationsToJson()
      const filename = `taffy-studio-${isoDate(new Date())}.json`
      if (IS_TAURI) {
        const path = await saveDialog({
          defaultPath: filename,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!path) return // user cancelled
        await fsWriteTextAbs(path, json)
      } else {
        downloadTextFile(filename, json)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onImport() {
    setBusy('import')
    setError(null)
    setLastImport(null)
    try {
      let text: string
      if (IS_TAURI) {
        const picked = await openDialog({
          multiple: false,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!picked) return
        // openDialog can return string | FileResponse depending on version; we
        // normalize down to a path string. multiple:false guarantees not array.
        const path =
          typeof picked === 'string'
            ? picked
            : Array.isArray(picked)
              ? null
              : (picked as { path?: string }).path ?? null
        if (!path) {
          setError('Could not read the selected file path.')
          return
        }
        text = await fsReadTextAbs(path)
      } else {
        const picked = await pickJsonFile()
        if (picked == null) return // user cancelled
        text = picked
      }
      const summary = await importConversationsFromJson(text)
      setLastImport(summary)
      // Refresh storage stats so the user sees the bumped DB size; then a
      // hard reload re-fetches the conversation list (no event bus yet).
      await refresh()
      // Wait briefly so the summary is visible before reload swaps the page.
      setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="storage-section">
      <h3>Storage</h3>

      {!IS_TAURI ? (
        <>
          <p className="muted-small">
            Conversations are stored on the server. Export downloads a JSON
            backup; Import merges one back in (new IDs minted, nothing
            overwritten).
          </p>
          <div className="storage-actions">
            <button
              type="button"
              className="ghost small"
              onClick={onExport}
              disabled={busy !== null}
              title="Download every conversation + message as a single JSON file"
            >
              {busy === 'export' ? 'Exporting…' : 'Export JSON…'}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={onImport}
              disabled={busy !== null}
              title="Merge conversations from an export JSON (new IDs minted; nothing overwritten)"
            >
              {busy === 'import' ? 'Importing…' : 'Import JSON…'}
            </button>
            <button
              type="button"
              className="small destructive-btn"
              onClick={() => setConfirmingReset(true)}
              disabled={busy !== null}
            >
              Reset…
            </button>
          </div>
          {lastImport && (
            <div className="storage-notice">
              Imported {lastImport.conversations} conversation
              {lastImport.conversations === 1 ? '' : 's'} ·{' '}
              {lastImport.messages} message{lastImport.messages === 1 ? '' : 's'}.
              <span className="muted-small"> Reloading…</span>
            </div>
          )}
        </>
      ) : info ? (
        <>
          <dl className="kv">
            <dt>Database</dt>
            <dd>
              <code className="path" title={info.dbPath}>
                {info.dbPath}
              </code>
              <span className="muted-small">
                {info.dbSize > 0 ? formatBytes(info.dbSize) : 'not created yet'}
              </span>
            </dd>
            <dt>Auto-backups</dt>
            <dd>
              <code className="path" title={info.backupsDir}>
                {info.backupsDir}
              </code>
              <span className="muted-small">
                {info.backups.length} kept (newest 7)
              </span>
            </dd>
          </dl>

          {info.backups.length > 0 && (
            <ul className="backup-list">
              {info.backups.slice(0, 5).map((b) => (
                <BackupRow key={b.path} b={b} />
              ))}
              {info.backups.length > 5 && (
                <li className="muted-small">
                  …and {info.backups.length - 5} older
                </li>
              )}
            </ul>
          )}

          <div className="storage-actions">
            <button
              type="button"
              className="ghost small"
              onClick={onBackupNow}
              disabled={busy !== null}
            >
              {busy === 'backup' ? '…' : 'Back up now'}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={onOpenFolder}
              disabled={busy !== null}
              title="Reveal in file manager (desktop only)"
            >
              {busy === 'open' ? '…' : 'Open folder'}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={onExport}
              disabled={busy !== null}
              title="Save every conversation + message to a single JSON file"
            >
              {busy === 'export' ? 'Exporting…' : 'Export JSON…'}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={onImport}
              disabled={busy !== null}
              title="Merge conversations from an export JSON (new IDs minted; nothing overwritten)"
            >
              {busy === 'import' ? 'Importing…' : 'Import JSON…'}
            </button>
            <button
              type="button"
              className="small destructive-btn"
              onClick={() => setConfirmingReset(true)}
              disabled={busy !== null}
            >
              Reset…
            </button>
          </div>

          {lastImport && (
            <div className="storage-notice">
              Imported {lastImport.conversations} conversation
              {lastImport.conversations === 1 ? '' : 's'} ·{' '}
              {lastImport.messages} message{lastImport.messages === 1 ? '' : 's'}.
              <span className="muted-small"> Reloading…</span>
            </div>
          )}
        </>
      ) : (
        <p className="muted-small">Loading…</p>
      )}

      {error && (
        <div className="storage-error">{error}</div>
      )}

      {confirmingReset && (
        <div className="reset-confirm">
          {IS_TAURI ? (
            <p>
              This deletes all conversations and messages. A snapshot is saved to
              <code className="path"> backups/</code> first; you can restore by
              copying it over{' '}
              <code>{info?.dbPath?.split(/[\\/]/).pop() ?? 'taffy-studio.db'}</code>.
            </p>
          ) : (
            <p>
              This permanently deletes all conversations and messages on the
              server. Export a JSON backup first if you might want them back.
            </p>
          )}
          <div className="storage-actions">
            <button type="button" className="ghost small" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="small destructive-btn"
              onClick={onReset}
              disabled={busy !== null}
            >
              {busy === 'reset' ? 'Resetting…' : 'Yes, reset'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function BackupRow({ b }: { b: BackupInfo }) {
  const name = b.path.split(/[\\/]/).pop() ?? b.path
  const when = b.modified ? new Date(b.modified * 1000).toLocaleString() : '—'
  return (
    <li className="backup-row" title={b.path}>
      <span className="backup-name">{name}</span>
      <span className="backup-meta">
        {formatBytes(b.size)} · {when}
      </span>
    </li>
  )
}

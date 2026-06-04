// Persistent KV — the spiritual replacement for electron-store.
// Backed by a JSON file in AppConfig dir.
import { Store } from '@tauri-apps/plugin-store'

let _store: Store | null = null

async function store(): Promise<Store> {
  if (_store) return _store
  // `defaults` is required by current StoreOptions; empty object is fine since
  // each setting carries its own default at the call site (see settings.ts).
  _store = await Store.load('settings.json', { autoSave: true, defaults: {} })
  return _store
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const s = await store()
  const v = await s.get<T>(key)
  return v ?? null
}

export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  const s = await store()
  await s.set(key, value)
}

export async function deleteSetting(key: string): Promise<void> {
  const s = await store()
  await s.delete(key)
}

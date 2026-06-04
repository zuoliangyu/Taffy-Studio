// Persistent KV — the spiritual replacement for electron-store.
// Transport lives in the backend driver (`services/api`): Tauri → plugin-store
// (settings.json in AppConfig dir); web → server-side KV.
import { api } from '../services/api'

export function getSetting<T = unknown>(key: string): Promise<T | null> {
  return api.kvGet<T>(key)
}

export function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  return api.kvSet<T>(key, value)
}

export function deleteSetting(key: string): Promise<void> {
  return api.kvDelete(key)
}

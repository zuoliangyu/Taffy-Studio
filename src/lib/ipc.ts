// Backwards-compatible facade over the backend driver. The actual transport
// (Tauri invoke vs HTTP) lives in `services/{tauriApi,webApi}.ts`; this module
// just keeps the historical import path stable for existing call sites.
import { api } from '../services/api'

export function getPlatform(): Promise<string> {
  return api.getPlatform()
}

/** Health-check the backend command surface. */
export function ping(payload: string): Promise<string> {
  return api.ping(payload)
}

/** Write a UTF-8 string to an absolute path. The caller is expected to have
 *  obtained `path` from `plugin-dialog`'s save() — that's what gates which
 *  paths the user has actually consented to write. */
export function fsWriteTextAbs(path: string, contents: string): Promise<void> {
  return api.fsWriteTextAbs(path, contents)
}

/** Read a UTF-8 string from an absolute path picked via plugin-dialog open(). */
export function fsReadTextAbs(path: string): Promise<string> {
  return api.fsReadTextAbs(path)
}

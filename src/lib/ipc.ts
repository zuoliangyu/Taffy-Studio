// Thin wrappers around Tauri's invoke(). Centralizing the command surface here
// is what lets you grep for "every Rust call from JS" in one place.
import { invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'

export async function getPlatform(): Promise<string> {
  // platform() is sync in @tauri-apps/plugin-os v2.
  return platform()
}

/** Health-check the Rust command surface. */
export function ping(payload: string): Promise<string> {
  return invoke<string>('ping', { payload })
}

/** Write a UTF-8 string to an absolute path. The caller is expected to have
 *  obtained `path` from `plugin-dialog`'s save() — that's what gates which
 *  paths the user has actually consented to write. */
export function fsWriteTextAbs(path: string, contents: string): Promise<void> {
  return invoke<void>('fs_write_text_abs', { path, contents })
}

/** Read a UTF-8 string from an absolute path picked via plugin-dialog open(). */
export function fsReadTextAbs(path: string): Promise<string> {
  return invoke<string>('fs_read_text_abs', { path })
}

// Single backend entry point. The renderer imports `{ api }` from here and
// never touches `@tauri-apps/*` or `fetch('/api/...')` directly.
//
// `__IS_TAURI__` is a compile-time boolean injected by Vite (true when built
// under the Tauri CLI, false for a plain web build — see vite.config.ts). The
// dead branch is dropped by the bundler, so only the active shell's driver
// ships. Both drivers expose identical signatures (TS enforces parity through
// this union), keeping component code transport-agnostic.
import * as tauriApi from './tauriApi'
import * as webApi from './webApi'

export const api = __IS_TAURI__ ? tauriApi : webApi

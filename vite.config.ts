import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/ ; Tauri-specific guidance: https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],

  // Tauri expects a fixed port and fails if it can't claim it.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust source.
      ignored: ['**/src-tauri/**'],
    },
  },

  // Env vars exposed to the renderer must start with VITE_ or TAURI_ENV_.
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  build: {
    // Match Tauri 2's webview minimums.
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Split the heavy renderer libs into their own chunks so the main
        // entry stays small. Mermaid is already loaded on demand via dynamic
        // import inside MessageContent, but giving it its own chunk lets the
        // browser cache it independently of unrelated changes.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-markdown': [
            'react-markdown',
            'remark-gfm',
            'remark-math',
            'rehype-katex',
          ],
          'vendor-katex': ['katex'],
          'vendor-syntax': ['react-syntax-highlighter'],
          'vendor-mermaid': ['mermaid'],
          'vendor-tauri': [
            '@tauri-apps/api',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-http',
            '@tauri-apps/plugin-log',
            '@tauri-apps/plugin-notification',
            '@tauri-apps/plugin-os',
            '@tauri-apps/plugin-shell',
            '@tauri-apps/plugin-sql',
            '@tauri-apps/plugin-store',
            '@tauri-apps/plugin-updater',
          ],
        },
      },
    },
  },
})

// Theme controller. The CSS already ships a full light + dark token set keyed
// off `prefers-color-scheme`; this lets the user pin a mode explicitly. We do
// it by writing `data-theme="light|dark"` on <html> (the CSS honors that
// attribute over the media query) — or removing it to defer to the OS.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getSetting, setSetting } from './store'

export type ThemeMode = 'system' | 'light' | 'dark'
const STORE_KEY = 'themeMode'

function apply(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

interface ThemeCtx {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system')

  useEffect(() => {
    getSetting<ThemeMode>(STORE_KEY)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setModeState(saved)
          apply(saved)
        }
      })
      .catch(() => {})
  }, [])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    apply(m)
    void setSetting(STORE_KEY, m)
  }, [])

  const value = useMemo<ThemeCtx>(() => ({ mode, setMode }), [mode, setMode])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme must be used within <ThemeProvider>')
  return v
}

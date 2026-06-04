// Tiny i18n runtime — no dependency, no bundle weight beyond the dictionaries.
//
// - `I18nProvider` holds the active locale, persists it to the Store plugin,
//   and seeds the initial value from a saved choice or the OS language.
// - `useI18n()` returns `{ t, locale, setLocale }`. `t(key, vars?)` looks up
//   the string and interpolates {placeholders}.
// - Falls back to English for any key missing in the active locale (can't
//   happen by construction — zh is `Record<TKey,string>` — but keeps us safe
//   if a locale is ever added loosely).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getSetting, setSetting } from '../lib/store'
import { en, locales, type Locale, type TKey } from './strings'

const STORE_KEY = 'locale'

function format(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k) =>
    k in vars ? String(vars[k]) : m,
  )
}

function detectLocale(): Locale {
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || '').toLowerCase()
    if (lang.startsWith('zh')) return 'zh'
  }
  return 'en'
}

export type TFunc = (key: TKey, vars?: Record<string, string | number>) => string

interface I18nCtx {
  locale: Locale
  setLocale: (l: Locale) => void
  t: TFunc
}

const Ctx = createContext<I18nCtx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  // Load the saved choice once on mount; overrides the OS-detected default.
  useEffect(() => {
    getSetting<Locale>(STORE_KEY)
      .then((saved) => {
        if (saved && saved in locales) setLocaleState(saved)
      })
      .catch(() => {})
  }, [])

  // Reflect the active locale on <html lang> for a11y + CSS hooks.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale
    }
  }, [locale])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    void setSetting(STORE_KEY, l)
  }, [])

  const t = useCallback<TFunc>(
    (key, vars) => {
      const dict = locales[locale] as Record<TKey, string>
      const tpl = dict[key] ?? en[key] ?? key
      return format(tpl, vars)
    },
    [locale],
  )

  const value = useMemo<I18nCtx>(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n must be used within <I18nProvider>')
  return v
}

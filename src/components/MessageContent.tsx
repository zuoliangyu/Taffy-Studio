// Render markdown chat content with code highlighting + GitHub flavor extras
// (tables, task lists, strikethrough, autolinks) + KaTeX math + Mermaid diagrams.
// User messages stay plain text.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import {
  oneDark,
  oneLight,
} from 'react-syntax-highlighter/dist/esm/styles/prism'
import 'katex/dist/katex.min.css'
import { autoCloseMarkdown } from '../lib/autoClose'

interface Props {
  content: string
  /** Render as plain pre-wrap text instead of markdown (use for user input). */
  plain?: boolean
  /** Bubble is still streaming — auto-close half-formed markdown so the layout
   *  doesn't flicker between paragraph and code-block on every token. */
  streaming?: boolean
}

const codeTheme =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? oneLight
    : oneDark

export function MessageContent({ content, plain, streaming }: Props) {
  // Memoize the stabilized text — autoCloseMarkdown is O(n), but we may call
  // it on every keystroke during streaming.
  const text = useMemo(
    () => (streaming ? autoCloseMarkdown(content) : content),
    [content, streaming],
  )

  if (plain) {
    return <div className="md-plain">{content}</div>
  }

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const text = String(children ?? '').replace(/\n$/, '')
            const match = /language-(\w+)/.exec(className ?? '')
            const isBlock = !!match || text.includes('\n')

            if (!isBlock) {
              return (
                <code className="md-inline-code" {...props}>
                  {children}
                </code>
              )
            }

            const lang = match?.[1] ?? 'text'
            // Mermaid: render the source as an SVG diagram instead of code.
            if (lang === 'mermaid') {
              return <MermaidBlock source={text} />
            }
            return <CodeBlock lang={lang} text={text} />
          },
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be blocked on some webview targets; silent fallback
    }
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy" onClick={onCopy}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={codeTheme as { [key: string]: CSSProperties }}
        customStyle={{
          margin: 0,
          padding: '12px 14px',
          borderRadius: 0,
          fontSize: 12.5,
          lineHeight: 1.55,
          background: 'transparent',
        }}
        wrapLongLines
      >
        {text}
      </SyntaxHighlighter>
    </div>
  )
}

// Mermaid is heavy (~600KB), lazy-loaded only when the first diagram appears.
// Re-renders on `source` change. Errors fall back to showing the raw text.
function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  // Each diagram needs a unique id so Mermaid's internal cache doesn't collide.
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        // Init once (idempotent enough; theme follows OS).
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'strict',
        })
        const { svg } = await mermaid.render(idRef.current, source)
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg
          setErr(null)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  if (err) {
    return (
      <div className="md-mermaid md-mermaid-err">
        <div className="md-code-bar">
          <span className="md-code-lang">mermaid (parse error)</span>
        </div>
        <pre>{source}</pre>
        <div className="md-mermaid-msg">{err}</div>
      </div>
    )
  }
  return <div className="md-mermaid" ref={ref} />
}

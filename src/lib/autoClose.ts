// While a chat reply is streaming we hand half-formed markdown to react-markdown.
// Unclosed ``` / ** / __ / * / _ / $$ / $ cause the renderer to flip layout on
// almost every token — text becomes a code block, then collapses back to a
// paragraph two tokens later. The fix: detect unclosed pairs and append their
// closers to the END of the text used for rendering. The DB still stores the
// original (unclosed) text; this is purely a render-time stabilizer.
//
// We make a single pass over the string to track which delimiters are currently
// open. Order matters: inline code (`) and fenced code (```) escape everything
// else, so they win.

export function autoCloseMarkdown(input: string): string {
  if (!input) return input

  const len = input.length
  let i = 0

  // Code state has three modes: none / inline (`...`) / fenced (```...```)
  type CodeState = 'none' | 'inline' | 'fenced'
  let code: CodeState = 'none'

  // Inline pair counts (only meaningful when not in code).
  let starStar = 0   // **
  let underUnder = 0 // __
  let star = 0       // single *
  let under = 0      // single _
  let tilde = 0      // ~~
  let dollarDollar = 0 // $$
  let dollar = 0       // $

  // Track if we ended on the start of a markdown table that's still mid-row,
  // so we can decide whether to pad with a trailing |. (Skipped: too noisy.)

  function startsWith(seq: string): boolean {
    return input.startsWith(seq, i)
  }

  while (i < len) {
    if (code === 'fenced') {
      // Look for closing ``` at line start (best effort: anywhere works for
      // most providers since they emit \n``` newline groups together).
      if (startsWith('```')) {
        code = 'none'
        i += 3
        continue
      }
      i++
      continue
    }
    if (code === 'inline') {
      if (input[i] === '`') {
        code = 'none'
        i++
        continue
      }
      i++
      continue
    }

    // code === 'none' — full markdown delimiters in play.
    if (startsWith('```')) {
      code = 'fenced'
      i += 3
      continue
    }
    if (input[i] === '`') {
      code = 'inline'
      i++
      continue
    }
    if (startsWith('**')) {
      starStar ^= 1
      i += 2
      continue
    }
    if (startsWith('__')) {
      underUnder ^= 1
      i += 2
      continue
    }
    if (startsWith('~~')) {
      tilde ^= 1
      i += 2
      continue
    }
    if (startsWith('$$')) {
      dollarDollar ^= 1
      i += 2
      continue
    }
    if (input[i] === '*') {
      // Skip if it's a bullet at column 0 (rough heuristic: prev char is \n or
      // string start AND next char is space).
      const prev = i > 0 ? input[i - 1] : '\n'
      const next = input[i + 1]
      if ((prev === '\n' || prev === undefined) && next === ' ') {
        i++
        continue
      }
      star ^= 1
      i++
      continue
    }
    if (input[i] === '_') {
      under ^= 1
      i++
      continue
    }
    if (input[i] === '$') {
      dollar ^= 1
      i++
      continue
    }

    i++
  }

  // Now patch trailing closers in the right (innermost-first) order. The
  // payload below is what we APPEND. Code wins, then $$, $, then inline pairs.
  let suffix = ''
  if (code === 'fenced') {
    // The fence may not have a trailing newline; add one so the closer lands on
    // its own line, which markdown parsers prefer.
    if (!input.endsWith('\n')) suffix += '\n'
    suffix += '```'
  } else if (code === 'inline') {
    suffix += '`'
  } else {
    if (dollarDollar) suffix += '$$'
    if (dollar) suffix += '$'
    if (starStar) suffix += '**'
    if (underUnder) suffix += '__'
    if (tilde) suffix += '~~'
    if (star) suffix += '*'
    if (under) suffix += '_'
  }

  return input + suffix
}

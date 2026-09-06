// ═══════════════════════════════════════════════════════════════════
// Text template parser (Batch 1c-3a)
// ═══════════════════════════════════════════════════════════════════
//
// Splits a text-template string into a flat list of literal +
// interpolation parts:
//
//   "Lat: {lat:.4f}°N"
//      ↓
//   [ { kind: 'literal', text: 'Lat: ' },
//     { kind: 'interp',  text: 'lat', spec: {precision:4, type:'f'} },
//     { kind: 'literal', text: '°N' } ]
//
// The expression text inside `{...}` is returned RAW — this module
// has no dependency on the xgis expression parser. The wiring layer
// (compiler/src/ir/lower.ts when 1c-3b lands) maps each interp part
// to a final TextPart by routing `text` through the xgis parser.
//
// Escapes: `\\{` → literal `{`, `\\}` → literal `}`, `\\\\` → `\\`.
// All other backslashes are left as-is so paths/regexes pass
// through untouched ("C:\\Users\\..." stays "C:\\Users\\...").
//
// Brace nesting inside an interp body is tracked at depth (xgis
// `match(...) { ... }` and similar are valid expressions). The
// spec separator `:` is recognised only at brace depth 0, so a
// colon nested inside braces is part of the expression, not the
// spec.
//
// #2551: brace depth alone is not enough — the expression grammar
// owns colons of its own. A `:` inside a `"…"` string literal
// belongs to the string, and the `:` of a ternary `? :` belongs to
// the ternary. The separator is therefore the first depth-0 colon
// that neither a string nor an open ternary has claimed.

import type { FormatSpec } from '../ir/render-node'
import { parseFormatSpec } from './spec-parser'

export interface TemplateLiteral {
  kind: 'literal'
  text: string
}
export interface TemplateInterp {
  kind: 'interp'
  text: string
  spec?: FormatSpec
}
export type TemplatePart = TemplateLiteral | TemplateInterp

/** Parse a raw template string into a flat sequence of parts.
 *  Empty input returns []. Throws on syntactic errors (unmatched
 *  brace, malformed spec). */
export function parseTextTemplate(input: string): TemplatePart[] {
  const out: TemplatePart[] = []
  let lit = '' // accumulating literal buffer
  let i = 0
  const n = input.length

  const flushLit = (): void => {
    if (lit.length > 0) {
      out.push({ kind: 'literal', text: lit })
      lit = ''
    }
  }

  while (i < n) {
    const c = input[i]!

    // Escapes
    if (c === '\\' && i + 1 < n) {
      const next = input[i + 1]!
      if (next === '{' || next === '}' || next === '\\') {
        lit += next
        i += 2
        continue
      }
      // Unrecognised escape — preserve verbatim
      lit += c
      i += 1
      continue
    }

    if (c === '}') {
      throw new Error(`text template: unmatched '}' at position ${i} in "${input}"`)
    }

    if (c === '{') {
      flushLit()
      // Scan body. Track brace depth so nested `{}` (e.g. inside
      // `match(.x) { a -> b }`) doesn't terminate early. Spec
      // separator `:` only counts at depth 0.
      let depth = 1
      let j = i + 1
      let colonAt = -1
      // Expression-grammar state, live only until the separator is
      // found — after it the remainder is a format SPEC, whose fill
      // char may legally be a quote (`{x:"^10}` = fill '"', align
      // '^', width 10), so the string machine must not run there.
      let inString = false // inside a `"…"` string literal
      let openTernaries = 0 // `?` seen, still owing its `:`
      while (j < n && depth > 0) {
        const cj = input[j]!
        if (cj === '\\' && j + 1 < n) {
          j += 2
          continue
        }
        if (inString) {
          if (cj === '"') inString = false
          j += 1
          continue
        }
        if (cj === '{') depth += 1
        else if (cj === '}') {
          depth -= 1
          if (depth === 0) break
        } else if (colonAt === -1) {
          if (cj === '"') inString = true
          else if (cj === '?' && depth === 1) {
            // `??` (QuestionQuestion) is one token, not a ternary —
            // it owes no colon. lexer.ts:107-111.
            if (input[j + 1] === '?') {
              j += 2
              continue
            }
            openTernaries += 1
          } else if (cj === ':' && depth === 1) {
            // `expr ? then : else` — parseExpr recurses into `then`,
            // so ternaries nest and each `?` claims exactly one `:`
            // (parser-expressions.ts:24-29).
            if (openTernaries > 0) openTernaries -= 1
            else colonAt = j
          }
        }
        j += 1
      }
      if (depth !== 0) {
        throw new Error(`text template: unclosed '{' at position ${i} in "${input}"`)
      }
      const exprEnd = colonAt === -1 ? j : colonAt
      const exprText = input.slice(i + 1, exprEnd).trim()
      if (exprText.length === 0) {
        throw new Error(`text template: empty expression in "{}" at position ${i} in "${input}"`)
      }
      let spec: FormatSpec | undefined
      if (colonAt !== -1) {
        const specText = input.slice(colonAt + 1, j)
        const { spec: parsed, consumed } = parseFormatSpec(specText)
        if (consumed !== specText.length) {
          throw new Error(
            `text template: trailing characters after format spec ` +
              `"${specText.slice(consumed)}" in "${input}"`,
          )
        }
        spec = parsed
      }
      out.push({ kind: 'interp', text: exprText, ...(spec ? { spec } : {}) })
      i = j + 1
      continue
    }

    lit += c
    i += 1
  }

  flushLit()
  return out
}

/** Convenience: returns true when the template is a single bare
 *  interp with no spec (e.g. "{name}"). The wiring layer can use
 *  this to short-circuit into a `TextValue.kind: 'expr'` instead
 *  of wrapping a single-element template, which keeps the legacy
 *  `label-[<expr>]` IR shape unchanged. */
export function isBareExpressionTemplate(parts: TemplatePart[]): boolean {
  return (
    parts.length === 1 &&
    parts[0]!.kind === 'interp' &&
    (parts[0] as TemplateInterp).spec === undefined
  )
}

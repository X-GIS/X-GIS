// Shared test helper (#1064). Prefix an inline `.xgis` test source with the
// mandatory version pragma so each suite's local compile/parse helper stays a
// one-liner and the pragma VALUE keeps a single authority (XGIS_LANGUAGE_MAJOR)
// — this is the "one seam" the migration issue prefers over editing every
// inline literal. Not a `*.test.ts` file, so vitest does not collect it.

import { XGIS_LANGUAGE_MAJOR } from '../language-version'

/** True iff `src` already opens with an `xgis <int>` pragma, skipping leading
 *  blank lines + `//` and block comments exactly as the lexer does. Lets
 *  `withPragma` stay idempotent so it can wrap BOTH hand-written sources and
 *  `convertMapboxStyle` output (which already carries the pragma). */
function hasPragma(src: string): boolean {
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    return /^xgis[ \t]+\d+\b/.test(src.slice(i))
  }
  return false
}

/** Prepend `xgis <major>` to an inline source, unless it already has a pragma
 *  (idempotent). When `src` opens with a newline — the usual multi-line-template
 *  shape — the pragma reuses that first blank line, so the source's own 1-based
 *  line numbers are unchanged (any diagnostic that reports `line` stays stable). */
export function withPragma(src: string): string {
  if (hasPragma(src)) return src
  return src.startsWith('\n')
    ? `xgis ${XGIS_LANGUAGE_MAJOR}${src}`
    : `xgis ${XGIS_LANGUAGE_MAJOR}\n${src}`
}

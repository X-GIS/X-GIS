// === #1848 - the glyph-failure warning was truncated to a bare font name ===
//
// `rangeKey()` joins (fontstack, rangeStart) with a NUL byte - a correct
// delimiter for an internal cache key, because a fontstack name may legally
// contain spaces and commas. The failure path then interpolated that INTERNAL
// key straight into a HUMAN-facing warning:
//
//   xlog.warn(`[X-GIS] glyph range ${key} failed to load - falling back ...`)
//
// Consoles stop rendering a string at the first NUL, so every surface that
// showed this warning - the browser console, the playground log mirror, a
// terminal - printed only the half before it:
//
//   [warn] [X-GIS] glyph range Noto Sans CJK KR Regular
//
// A warning with no verb, no range, and no stated consequence. The reporter
// could not tell whether it was an error, which codepoints were lost, or that
// the engine had already recovered onto system fonts.
//
// The invariant pinned here is the user-facing one: a log line the engine emits
// must be legible end to end. Internal key encodings stay internal.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLogSink } from '@xgis/shared'
import { GlyphPbfCache } from './glyph-pbf-cache'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The same fixture the sibling suites decode - a real MapLibre glyph range. */
const PBF_BYTES = readFileSync(join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf'))

const URL_TEMPLATE = 'https://x/{fontstack}/{range}.pbf'
/** The fontstack from the #1848 report - spaces included, which is exactly why
 *  the internal cache key needs a NUL delimiter in the first place. */
const STACK = 'Noto Sans CJK KR Regular'

/** Let the cache's microtask chain (response -> body -> decode) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

function captureWarnings(): string[] {
  const lines: string[] = []
  setLogSink((level, message) => {
    if (level === 'warn') lines.push(message)
  })
  return lines
}

/** True iff `s` carries a C0 control character - the class a console truncates
 *  on (NUL) or renders as a replacement box. Spelled with charCodeAt rather
 *  than a regex range so this file itself stays free of control literals. */
const hasControlChar = (s: string): boolean =>
  s.split('').some((c) => c.charCodeAt(0) < 0x20 && c !== '\n' && c !== '\t')

afterEach(() => setLogSink(null))

describe('#1848 - a failed glyph range logs a legible warning', () => {
  it('names the fontstack, the range and the outcome, with no control characters', async () => {
    const warnings = captureWarnings()
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    })
    // U+AC00 sits in range 44032-44287 - a range whose start is NOT 0, so a
    // message that dropped the range entirely cannot pass by coincidence.
    cache.ensure(STACK, 0xac00, () => {})
    await settle()

    const line = warnings.find((l) => l.includes('glyph range'))
    expect(line, 'the failure is reported at all').toBeDefined()

    // -- The defect itself. Pre-fix the line carried a raw NUL, and every
    //    assertion below it failed because the console cut the string there.
    expect(hasControlChar(line!), 'no control character reaches a user-facing log line').toBe(false)

    expect(line, 'the font that failed is named').toContain(STACK)
    expect(line, 'the codepoint range is named').toContain('44032-44287')
    expect(line, 'the line says what happened').toMatch(/failed to load/)
    expect(line, 'and what the engine did about it').toMatch(/system fonts/)
  })

  it('CONTROL - a range that loads logs no failure warning at all', async () => {
    const warnings = captureWarnings()
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response(PBF_BYTES, { status: 200 })),
    })
    cache.ensure('Open Sans Semibold', 0x41, () => {})
    await settle()
    // Without this arm, a cache that warned on EVERY range would pass above.
    expect(cache.get('Open Sans Semibold', 0x41), 'the range really loaded').toBeDefined()
    expect(warnings.filter((l) => l.includes('glyph range'))).toHaveLength(0)
  })
})

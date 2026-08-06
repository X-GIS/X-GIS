// ═══ DEBUG_OVERDRAW confinement gate — the #1594 promise, built ═══
//
// `DEBUG_OVERDRAW` is a page-load URL truth (debug-flags.ts); every consumer —
// pass layer AND draw layer — must ask the device-aware authority instead,
// `isOverdrawActive(caps)` (same file). #1046 Inc-F2d centralized the pass layer
// first (`scene.overdraw` / `ctx.overdraw`); #1594 closed the draw layer, the
// 19 sites that used to read the raw const directly and produced a half-gated
// frame on an immediate device (targets routed as ordinary, draws still
// skipping/substituting as if the accumulator were live).
//
// Unlike `execution-model-confinement.test.ts` (four interim per-file
// exceptions, each dying at a named future milestone), this gate has exactly
// ONE legitimate producer and no interim consumers: every draw-layer site
// converted in the same increment that added the authority function, so the
// allowlist is empty by construction. A future raw read is not an "interim
// exception to record" — it is the regression this gate exists to catch.
//
// Applies the #996 lesson: matcher and walk are proven non-vacuous below, and
// `debug-flags.ts` itself is asserted to have a NON-ZERO count — proof the
// walk actually reaches the source-of-truth file and the regex matches
// something real there, not just an artifact of an empty allowlist.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAP_SRC = join(dirname(fileURLToPath(import.meta.url)))

// The bare token — DEBUG_OVERDRAW has no legitimate dotted-access reader shape
// (unlike executionModel's `.caps.executionModel`), so one regex covers both a
// direct read and an aliased import (`import { DEBUG_OVERDRAW as X }` still
// spells the real export name at the import site).
const TOKEN = () => /\bDEBUG_OVERDRAW\b/g

function walkSrcTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkSrcTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}

describe('DEBUG_OVERDRAW confinement: read only in debug-flags.ts (#1594)', () => {
  const files = walkSrcTs(MAP_SRC)
  const rel = (abs: string): string => abs.slice(MAP_SRC.length + 1).replaceAll('\\', '/')

  it('the matcher still matches (not vacuous — #996)', () => {
    expect('if (DEBUG_OVERDRAW) return'.match(TOKEN())).toHaveLength(1)
    expect('import { DEBUG_OVERDRAW as X } from "./debug-flags"'.match(TOKEN())).toHaveLength(1)
    expect('caps.executionModel'.match(TOKEN())).toBeNull()
  })

  it('the walk reaches the real map/src tree (not vacuous — #996)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith(join('map', 'src', 'render-loop.ts')))).toBe(true)
  })

  it('debug-flags.ts is the SOLE non-test file mentioning the token', () => {
    const observed = files.filter((f) => TOKEN().test(readFileSync(f, 'utf8'))).map(rel)
    expect(
      observed,
      'DEBUG_OVERDRAW may be read only in debug-flags.ts — every other consumer must call ' +
        'isOverdrawActive(caps) instead (#1594). A new raw read here is the exact half-gated- ' +
        'frame regression this gate exists to catch; port it behind the authority, do not ' +
        'allowlist it.',
    ).toEqual(['debug-flags.ts'])
  })

  it('debug-flags.ts itself has a non-zero count (the walk reads real content, not just an empty set)', () => {
    const src = readFileSync(join(MAP_SRC, 'debug-flags.ts'), 'utf8')
    expect((src.match(TOKEN()) ?? []).length).toBeGreaterThan(0)
  })
})

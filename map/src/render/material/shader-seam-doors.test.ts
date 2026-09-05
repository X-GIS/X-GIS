// ═══ #2499 step 2 — the shader seam has exactly two doors, and both are on a list ═══
//
// After #2499 steps 0–3 every registered family reads its bake, and the seam's id is
// REQUIRED (`wgsl-for.ts`): a call site cannot leave it off. What a type cannot see is the
// two ways a runtime emit can still reach the driver, and both are legitimate in a bounded
// set of places:
//
//   1. THE `LIVE` DOOR — `wgslFor(rhi, emit, LIVE)`: the open set (a shader whose bytes are
//      a function of style data that does not exist at build time), a family the closed set
//      excludes by decision, or a variant carrier that is `undefined` while a composer
//      variant is live. Spelled, so it can be listed.
//   2. A BYPASS — an `emit…Wgsl(` / `emit…Glsl(` / `emit…GlslStages(` call whose result never
//      passes through the seam at all (`device.createShaderModule({ code: emitX() })`, a
//      `vsCode: emitX()` field, an eligibility probe that emits to regex the text). Nothing
//      counts these — the store never sees them, and the pixels are identical either way
//      — which is exactly how the WebGPU polygon path emitted 26 KB of WGSL on every boot for
//      a month with the bake sitting unread (#2499). The boot provenance gate catches a
//      bypass ON the boot scene; this file catches one anywhere in map/src, at the source.
//
// Both lists are SHRINK-ONLY and carry a reason per entry: a new `LIVE` caller or a new bypass
// reds until it is listed with its reason, and an entry whose door closed must be deleted in
// the same commit (an allowlist that outlives its reason is how a deferral becomes permanent
// by accident — the DEFERRED lesson of `simple-family-rewiring.test.ts`).
//
// The scanner is paren-aware, not per-line: the census that found the bypasses in the first
// place mis-counted twice on per-line regexes (a thunk on its own line reads as a bypass, an
// emit in a comment reads as a call). Comments are blanked to spaces (offsets preserved),
// strings are skipped, and an emit call counts as SEAMED only when its offset lies inside the
// argument span of a `wgslFor(` / `glslFor(` / `glslStagesFor(` / `bakedWgsl(` call.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Files the scan covers: every non-test, non-generated .ts under map/src, minus the DSL
 *  (where emitters are DEFINED), the bake (where they are ENUMERATED) and the seam itself. */
function scannedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.generated.ts'))
        continue
      const rel = relative(MAP_SRC, p)
      if (rel.startsWith('shaders/dsl/') || rel.startsWith('shaders/baked/')) continue
      if (rel === 'render/material/wgsl-for.ts') continue
      out.push(rel)
    }
  }
  walk(MAP_SRC)
  return out.sort()
}

/** Blank every comment to spaces so offsets survive; strings are left in place (the walker
 *  below skips them) but a `//` INSIDE a string must not start a comment, so this is one
 *  pass over the text with a tiny state machine rather than two regexes. */
export function blankComments(src: string): string {
  const out = src.split('')
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' '
      continue
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < n) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    i++
  }
  return out.join('')
}

/** The [open, close] offsets of the argument list that starts at `openParen`. */
function closeOf(src: string, openParen: number): number {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

const SEAM_CALL = /\b(?:wgslFor|glslFor|glslStagesFor|bakedWgsl)\s*\(/g
const EMIT_CALL = /\bemit[A-Za-z0-9]*(?:Wgsl|Glsl|GlslStages)\s*\(/g

/** Offsets of emitter calls in `src` (comments already blanked) that no seam call encloses. */
export function bypassesIn(src: string): number[] {
  const spans: Array<[number, number]> = []
  for (const m of src.matchAll(SEAM_CALL)) {
    const open = m.index + m[0].length - 1
    spans.push([open, closeOf(src, open)])
  }
  const out: number[] = []
  for (const m of src.matchAll(EMIT_CALL)) {
    const at = m.index
    if (!spans.some(([a, b]) => at > a && at < b)) out.push(at)
  }
  return out
}

const lineOf = (src: string, offset: number): number => src.slice(0, offset).split('\n').length

/** Files allowed to open the LIVE door, each with the reason it has no baked id. */
const LIVE_DOORS: Readonly<Record<string, string>> = {
  'render/material/coverage-material.ts':
    'open set — `CoverageFilterFn` is compiled from the layer style; the bytes do not exist at build time',
  'render/rhi-fill-variant.ts':
    'open set — a composer variant (`emitPolygonWgsl(composed, …)`); the closed set holds the variant-free program only (#1679 NOT_BAKED)',
  'render/material/atmosphere-material.ts':
    '#1258 — off by default and decorative; kept out of the closed set by decision (registry-emitter-coverage ALLOWLIST)',
  'render/material/line-material.ts':
    'variant carrier — `bakedLineIds` is undefined while a composer variant is live, so every line seam call spells `?? LIVE` (#1679 inc 7 wrong-bytes guard)',
  'render/material/point-material.ts':
    'variant carrier — `bakedPointIds` is undefined while `shaderVariant` is live (#1679 inc 6 G1)',
}

/** Files allowed to call an emitter outside the seam, each with the reason. */
const BYPASSES: Readonly<Record<string, string>> = {
  'render/polygon-shader-cache.ts':
    'the polygon WGSL choke point: the null-variant branches go through `bakedWgsl`; the composer-variant branches ARE the open set, emitted raw and memoised per variant/pick/body epoch',
  'render/material/line-material.ts':
    '`splitEligible()` emits the split module to regex its group(0) bindings (variant drapers only; the null variant short-circuits) — derive eligibility from the IR instead (#2499 note)',
  'render/compose-pipelines.ts':
    '`emitOverdrawComposeWgsl` — the ?debug=overdraw compose pass, a debug-only fullscreen module (registry-emitter-coverage ALLOWLIST)',
  'debug-flags.ts':
    '`emitOverdrawFsWgsl` — the ?debug=overdraw fragment source, debug-only (registry-emitter-coverage ALLOWLIST)',
  'shaders/emit/shader-emit-request.ts':
    "hillshade's emit POOL (#1678 phase A): the pool is seeded from the hillshade artifact by `seed-hillshade.ts` and emits only on a pool miss — its own mechanism, deliberately apart from the store seam",
}

describe('#2499 step 2 — scanner sanity (not vacuous — #996)', () => {
  it('blankComments removes comment text and keeps offsets', () => {
    const src = "a // emitFooWgsl(\nb /* emitBarGlsl( */ c 'x // not a comment'"
    const blanked = blankComments(src)
    expect(blanked.length).toBe(src.length)
    expect(blanked).not.toContain('emitFooWgsl')
    expect(blanked).not.toContain('emitBarGlsl')
    expect(blanked).toContain("'x // not a comment'")
  })

  it('an emit inside a seam call is SEAMED; the same emit outside is a BYPASS', () => {
    expect(bypassesIn('shader: wgslFor(rhi, () => emitFooWgsl(a, (b)), id),')).toEqual([])
    expect(bypassesIn('...glslStagesFor(rhi, () => emitGlslStages(build(x)), LIVE),')).toEqual([])
    expect(bypassesIn('code: emitFooWgsl(),')).toHaveLength(1)
    expect(
      bypassesIn('const w = emitLineSplitWgsl(v, false)\nwgslFor(r, () => emitLineWgsl(v), id)'),
    ).toHaveLength(1)
  })

  it('the walk reaches the real tree', () => {
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('render/material/line-material.ts')
    expect(files).not.toContain('render/material/wgsl-for.ts')
  })
})

describe('#2499 step 2 — door 1: every LIVE caller is listed with its reason', () => {
  const users = scannedFiles().filter((rel) =>
    /\bLIVE\b/.test(blankComments(readFileSync(join(MAP_SRC, rel), 'utf8'))),
  )

  it('the scan found the known callers (else the arms below pass over nothing)', () => {
    expect(users.length).toBeGreaterThanOrEqual(5)
  })

  it('LIVE callers === LIVE_DOORS (both directions, shrink-only)', () => {
    expect(
      users.sort(),
      `a file opened the LIVE door without a row here, or a row outlived its door. Every ` +
        `LIVE caller needs a reason the closed set cannot carry its bytes; a file that stopped ` +
        `passing LIVE must lose its row in the same commit.`,
    ).toEqual(Object.keys(LIVE_DOORS).sort())
  })

  it('every reason cites an issue or the decision that owns it', () => {
    for (const [file, reason] of Object.entries(LIVE_DOORS))
      expect(reason, `LIVE_DOORS['${file}']`).toMatch(/#\d+|open set/)
  })
})

describe('#2499 step 2 — door 2: every emitter call outside the seam is listed with its reason', () => {
  const found = new Map<string, number[]>()
  for (const rel of scannedFiles()) {
    const src = blankComments(readFileSync(join(MAP_SRC, rel), 'utf8'))
    const hits = bypassesIn(src)
    if (hits.length > 0)
      found.set(
        rel,
        hits.map((o) => lineOf(src, o)),
      )
  }

  it('the scan found the known bypasses (else the arms below pass over nothing)', () => {
    expect([...found.values()].flat().length).toBeGreaterThanOrEqual(5)
    expect(found.has('shaders/emit/shader-emit-request.ts')).toBe(true)
  })

  it('bypass files === BYPASSES (both directions, shrink-only)', () => {
    const detail = [...found].map(([f, lines]) => `${f}:${lines.join(',')}`).join('\n  ')
    expect(
      [...found.keys()].sort(),
      `an emitter is called outside the seam in a file with no row here, or a row outlived ` +
        `its bypass. A shader source must reach the driver through wgslFor / glslFor / ` +
        `glslStagesFor / bakedWgsl (the store first, shipSource on a miss) or be listed with ` +
        `the reason it cannot — the boot provenance gate sees a bypass only on the boot scene; ` +
        `this arm sees it anywhere.\n  ${detail}`,
    ).toEqual(Object.keys(BYPASSES).sort())
  })

  it('every reason names the mechanism or the decision', () => {
    for (const [file, reason] of Object.entries(BYPASSES))
      expect(reason.length, `BYPASSES['${file}'] needs a real reason`).toBeGreaterThan(40)
  })
})

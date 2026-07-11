// ═══ Raw-shader-string ratchet — no hand-authored WGSL/GLSL in map/src + engine/src ═══
//
// The charter invariant (docs/architecture/render-graph-pass-scheduler.md §8.5,
// "THE acceptance test"): a shader HARDCODED as a string / template literal of
// WGSL or GLSL is "forbidden EVERYWHERE (engine AND content)". The backend
// (WebGPU vs WebGL2) is a RUNTIME decision, so every shader is authored via the
// neutral @xgis/shader-dsl IR and emitted per the live backend — never a
// hand-written `@vertex … fn main(…)` / `#version … void main(){ gl_Position … }`
// template. Authoring a raw shader string re-hardcodes a backend and forks the
// WGSL/GLSL twins that the DSL exists to keep in lockstep.
//
// Un-gated TODAY. Gate A (runtime/src/engine/shader-codegen-srp-ratchet.test.ts)
// already bans this — but its SRC_DIRS are ['runtime/src', 'compiler/src',
// 'blueprint/src', 'shared/src']. It OMITS the two packages that author the most
// shaders: @xgis/map (map/src/shaders/dsl/*) and the extracted @xgis/engine
// (engine/src/shaders/dsl/*). NOTE `engine/src` is the NEW @xgis/engine package,
// NOT `runtime/src/engine/` (which Gate A does cover). So the exact place a raw
// shader is most likely to be typed is the exact place Gate A can't see. This
// gate is Gate A's signal pointed at those two dirs — completing the §8.5
// "forbidden EVERYWHERE" enforcement across every shader-authoring package.
//
// CLEAN today → EMPTY baseline that LOCKS the win. Both dirs already author 100%
// through the DSL (function-built IR + `emitModule`/`emitGlslModule`), so the
// current footprint is 0. Seeding `{}` means there is nothing to "drive to 0" —
// the gate exists to keep it 0: the first raw shader string added to either dir
// fails immediately. Closes #1006 (the raw-shader-string part; the dedup-cluster
// sub-items of #1006 stay open).
//
// SIGNAL (mirrors Gate A's exact "raw shader string" test — a backtick template
// literal whose body carries WGSL/GLSL entry-point/builtin source), over
// COMMENT-STRIPPED code (Gate A's `[^:]`-guarded strip, so a `//`/JSDoc mention
// of gl_Position or a `https://` URL is not a false positive):
//   WGSL  →  @compute / @vertex / @fragment  ·  fn main(
//   GLSL  →  #version  ·  void main(  ·  precision {highp|mediump|lowp}
//   both  →  gl_Position · gl_FragColor
// map/engine author BOTH backends' twins (e.g. line.ts WGSL + line-glsl.ts GLSL),
// so the marker set spans WGSL and GLSL entry points — wider than Gate A's
// WGSL-leaning set, but every marker is verified 0 here (2026-07-11).
// EXCLUDED — the DSL's own legitimate vocabulary, NOT raw shader source:
//   • `@location` — the DSL attribute (`location(0, …)`, `retAttr: '@location(0)'`)
//     and the WGSL-PARSING test helper render/__vertex-format-crosscheck.ts. It is
//     authored, never hand-written shader body, so it is not a marker.
//   • bare `precision ` — an English-prose word (error/log messages); the GLSL
//     `precision {highp|mediump|lowp}` qualifier form catches every real GLSL
//     precision statement while staying immune to prose.
//
// STRICT shrink-only, BOTH directions, over the UNION of scanned+baseline files
// (mirrors raw-webgpu-ratchet.test.ts / #929). With an empty baseline the only
// reachable branch is "new leak", but the skeleton stays faithful so any future
// allowlisted exception self-heals: `> baseline` = a NEW raw shader (author it via
// the DSL); a baselined file that reaches 0 = win not locked (delete the entry).
// The union scan is the #996 vacuity guard — a baseline entry pointing at a
// moved/deleted/cleaned file FAILS loudly, never passes green-while-dead.
//
// GPU-free; co-located in map/src so it rides the `test (map)` CI leg
// (`vitest map/src`). It also scans engine/src: an engine/src change sets the
// `code` filter, which runs the whole matrix — the `map` leg included — so this
// gate covers engine/src with no CI-dark gap. Baseline measured 2026-07-11:
// 0 tokens / 0 files across map/src + engine/src (192 scanned). Close-out = this
// gate AND Gate A both empty = §8.5 realised across all packages.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_DIRS = ['map/src', 'engine/src']

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')

// Strip block + line comments so a JSDoc/`//` mention of `@vertex` or a comment
// citing `gl_Position` is NOT a false positive. The `[^:]` guard keeps `://`
// (URLs) intact — Gate A's exact strip (shader-codegen-srp-ratchet.test.ts).
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// A backtick template literal whose body carries WGSL/GLSL entry-point/builtin
// source (Gate A's RAW_SHADER_TEMPLATE, extended to the GLSL entry markers +
// global for per-file counting). Anchored to backticks so single-quoted DSL
// attribute values like `retAttr: '@location(0)'` never match.
const RAW_SHADER_TEMPLATE =
  /`[^`]*?(@compute\b|@vertex\b|@fragment\b|fn\s+main\s*\(|gl_Position|gl_FragColor|#version|void\s+main\s*\(|precision\s+(?:highp|mediump|lowp)\b)[\s\S]*?`/g

function rawShaderStringCount(abs: string): number {
  return (stripComments(readFileSync(abs, 'utf8')).match(RAW_SHADER_TEMPLATE) || []).length
}

// Per-file raw-shader-string count. SHRINK-ONLY: EMPTY = map/src + engine/src
// author every shader via @xgis/shader-dsl (no hand-written WGSL/GLSL). A new raw
// shader adds its file here (fail); a future allowlisted exception that gets fixed
// must delete its entry in the same commit. Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {}

describe('raw-shader-string ratchet: map/src + engine/src author shaders via the DSL (#1006, §8.5)', () => {
  it('no .ts hand-authors a WGSL/GLSL shader string (shrink-only baseline)', () => {
    const actual = new Map<string, number>()
    for (const abs of SRC_DIRS.flatMap((d) => walkTs(join(ROOT, d)))) {
      const n = rawShaderStringCount(abs)
      if (n > 0) actual.set(rel(abs), n)
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} raw WGSL/GLSL shader string(s), not in baseline — author via @xgis/shader-dsl ` +
            `IR (module/fn/emitModule|emitGlslModule), never a hand-written template literal`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (migrated to the DSL; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW raw shader string(s); author via the shader-dsl, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — raw shader(s) migrated; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `Raw-shader-string footprint of map/src + engine/src drifted from the §8.5 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

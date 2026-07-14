// ═══ Forced-cast ratchet — `as any` / `as unknown as` / `as never` / @ts-suppress ═══
//
// A forced cast is a hole in the type system: the compiler stops checking the
// seam, so when either side later drifts (a field renamed, a union arm added,
// a param widened), tsc stays green and the break surfaces at RUNTIME — in
// this codebase that means a wrong pixel or a dead layer with no signal
// pointing back at the seam that lied. The 2026-07 audit found exactly that
// pattern: 11 dead `variant as any/never` casts in map.ts were armor over a
// seam whose types ALREADY agreed — their only possible effect was to hide a
// future divergence (see the twin `ShaderVariantInfo` collision they masked).
//
// This gate freezes the audited footprint per file so new holes can't slip in
// silently. Counted per file, over the non-test sources of every live package
// (runtime/ excluded — retiring tree, #1005):
//   • `as any`, `as never`, `as unknown as` on COMMENT-STRIPPED source (the
//     escape-hatch trio; `as const` / ordinary `as T` narrowing are NOT
//     counted — they stay type-checked on at least one side)
//   • `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` on RAW source (these
//     live inside comments, so they must be counted BEFORE stripping) — and
//     only at DIRECTIVE position (`//` or `/*` immediately introducing it),
//     so JSDoc prose that merely mentions "@ts-expect-error" is not counted
//     (the audit found exactly one such false positive, node.ts)
//
// STRICT-equal, both directions, mirroring the raw-webgpu ratchet (#991) and
// the #929 shrink-only baseline convention:
//   • actual > baseline → a NEW forced cast. Fix the type seam instead. If it
//     is genuinely principled (documented invariant the type system cannot
//     express), add a justifying comment at the site and bump WITH a one-line
//     rationale here.
//   • actual < baseline → holes closed. LOWER the baseline in the same commit
//     (locking the win). A stale entry for a clean/deleted file fails the
//     same way — the #996 vacuity guard falls out of the both-direction scan.
//
// Test files are excluded by the walk (casts in tests are frequently the
// point — probing invalid inputs past the compiler). GPU-free; rides the
// `test (map)` CI leg like the co-located loc-ceiling ratchet (#1003).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = [
  'shared/src',
  'geo/src',
  'shader-dsl/src',
  'rhi/src',
  'engine/src',
  'rhi-webgpu/src',
  'rhi-webgl2/src',
  'compiler/src',
  'map/src',
  'data/src',
  'blueprint/src',
]

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

// Strip block + line comments so `as any` in prose (docs quoting the
// anti-pattern) is not counted as code.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// The escape-hatch trio. `\s+` spans newlines — prettier may wrap
// `as unknown as\n  SomeLongType`.
const CAST_RES = [/\bas\s+any\b/g, /\bas\s+never\b/g, /\bas\s+unknown\s+as\b/g]
// Suppression directives live IN comments — matched on raw source, but only
// where a comment opener directly introduces the directive (TS only honors
// that position). A JSDoc body line quoting `@ts-expect-error` in prose has
// no adjacent `//` / `/*` opener and is correctly ignored.
const SUPPRESS_RE = /(?:\/\/|\/\*)\s*@ts-(ignore|expect-error|nocheck)\b/g

function forcedCastCount(abs: string): number {
  const raw = readFileSync(abs, 'utf8')
  const code = stripComments(raw)
  let n = 0
  for (const re of CAST_RES) n += (code.match(re) || []).length
  n += (raw.match(SUPPRESS_RE) || []).length
  return n
}

// Per-file forced-cast count. SHRINK-ONLY: closing a hole lowers its number
// (to 0 = delete the entry) in the same commit. Measured 2026-07-13 after the
// cast audit (145 → 77 across 54 → 32 files); every survivor is a reviewed
// PRINCIPLED site (nominal RHI-handle mint, globalThis singletons, worker
// boundaries, branded tokens, staged construction, generic-variance limits,
// geojson-vt in-place transmutation — each documented at the site). Ordered
// by path.
const BASELINE: Record<string, number> = {
  'blueprint/src/editor.ts': 3,
  'compiler/src/tiler/geojsonvt/transform.ts': 3,
  'data/src/workers/geojson-compile-worker.ts': 3,
  'data/src/workers/geojson-tiling-worker.ts': 1,
  'data/src/workers/mvt-worker.ts': 4,
  'map/src/diagnostics.ts': 5,
  'map/src/feature-update-queue.ts': 1,
  'map/src/layer.ts': 1,
  'map/src/map.ts': 6,
  'map/src/render-loop.ts': 6,
  'map/src/render/line-renderer.ts': 1,
  'map/src/render/passes/label-pass.ts': 1,
  'map/src/render/pipeline-factory.ts': 1,
  'map/src/render/point-renderer.ts': 1,
  'map/src/render/projection-token.ts': 3,
  'map/src/render/tile-selection-cache.ts': 1,
  'map/src/render/vector-tile-renderer.ts': 2,
  'map/src/shaders/dsl/projections.ts': 2,
  'map/src/source-manager.ts': 5,
  'map/src/sprite/icon-renderer.ts': 1,
  'map/src/sprite/sprite-atlas-host.ts': 1,
  'map/src/stats.ts': 1,
  'map/src/text/text-renderer.ts': 1,
  'map/src/text/text-wrap.ts': 1,
  'rhi-webgpu/src/gpu-timer.ts': 1,
  'rhi-webgpu/src/gpu.ts': 1,
  // 12→13 (#1046 F2): acquireScreenView's reused screen-view holder returns
  // `Native<GPUTextureView> as unknown as RhiTextureView` — the SAME opaque-handle
  // bridge the file's 5 `wrapWebGpu*` helpers use, needed for a zero-alloc reused view.
  'rhi-webgpu/src/rhi-webgpu.ts': 13,
  'shader-dsl/src/core/fp64/df64-lib.ts': 1,
  'shader-dsl/src/core/ir/builder.ts': 4,
  'shader-dsl/src/core/ir/node.ts': 1,
  'shader-dsl/src/core/oracle.ts': 1,
  'shared/src/body.ts': 1,
}

describe('forced-cast ratchet: type-system holes only shrink', () => {
  it('per-file forced-cast count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const pkg of PKGS) {
      for (const abs of walkTs(join(ROOT, pkg))) {
        const n = forcedCastCount(abs)
        if (n > 0) actual.set(rel(abs), n)
      }
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} forced cast(s), not in baseline — fix the type seam instead; ` +
            `if genuinely principled, document it at the site and add '${f}': ${a} with a rationale`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (hole closed; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW forced cast(s); fix the type seam, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — hole(s) closed; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `Forced-cast footprint drifted from the audited baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

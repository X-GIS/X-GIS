// ═══ God-file LOC ceiling ratchet — map/engine/geo/data/rhi* ═══
//
// The arch-invariants NEW_FILE_CAP gate (runtime/src/engine/architecture-invariants.
// test.ts) walks only runtime/compiler/blueprint/shared, so the repo's biggest,
// fastest-growing files have NO growth ceiling — the gate's own comment concedes it:
// "package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up".
// This is that follow-up (#1003), extended to geo/data/rhi* too.
//
// Co-located under map/src (not the retiring runtime/ tree, per #1005) so it rides
// the confirmed `test (map)` CI leg; it READS files across the listed packages (it
// does not import them). CEILING semantics (shrink-only high-water marks, like the
// arch-invariants gate): a baselined file may only stay ≤ its ceiling; no NON-
// baselined source file may cross NEW_FILE_CAP. LOWER a ceiling when a file shrinks.
//
// Applies the #996 lesson (a gate whose allowlist points at moved/deleted files is
// vacuously green): every CEILINGS key MUST still exist, or the test fails loudly.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = [
  'map/src',
  'engine/src',
  'geo/src',
  'data/src',
  'rhi/src',
  'rhi-webgpu/src',
  'rhi-webgl2/src',
]
const NEW_FILE_CAP = 800

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
function lineCount(abs: string): number {
  const s = readFileSync(abs, 'utf8')
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}
function exists(abs: string): boolean {
  try {
    statSync(abs)
    return true
  } catch {
    return false
  }
}

// High-water LOC ceilings for the god-files in these packages. SHRINK-ONLY: lower a
// number when its file shrinks; a file NOT listed here must stay under NEW_FILE_CAP.
// Measured 2026-07-11. (line.ts / polygon.ts are also ceiling-gated by the runtime
// arch-invariants test until runtime/ retires — #1005; the tighter ceiling governs.)
const CEILINGS: Record<string, number> = {
  // 4334→4336 (#991 P2): the UniformRing relocation to @xgis/engine injects the
  // perf-mark coupling via onGrowStart/onGrowEnd callbacks the engine no longer
  // owns; VTR (the ring that grows under load — the perf-audit hot path) supplies
  // them at the ring ctor (+2 lines). Lower again as #991 decomposes VTR.
  // 4336→4397 (#599 I2): the globe vector great-circle drape SEAM — the bake→
  // drape logic itself is EXTRACTED to render/vector-drape-renderer.ts (a new
  // ~180-LOC file); VTR keeps only the sphere-route gate + one invocation + a
  // dedicated bake uniform block (so the mid-render bake can't clobber the
  // shared frameBlock the stroke draw reads). Lower as #991 decomposes VTR.
  // 4397→4403 (#599 I3): the drape baked-fill cache lifecycle wire — two call
  // sites into VTR's existing beginFrame (deferred cache eviction, post-submit
  // safe window) + destroy (free baked textures). The policy itself lives in
  // render/vector-drape-cache.ts + vector-drape-renderer.ts, not here.
  // 4403→4487 (#599 line-drape): globe vector LINE / polygon-OUTLINE drape — the
  // stroke bake reuses the fill bake pass but adds the SDF line segments to the
  // tile texture. The bake-layer-slot packing + cache key + segment draw are
  // EXTRACTED to render/vector-drape-stroke.ts; VTR keeps only the wiring (the
  // captured stroke style + the drape-seam gate/strokeKey + the drawStrokes
  // suppression + the in-bake bakeTileStrokes call). Lower as #991 decomposes VTR.
  'map/src/render/vector-tile-renderer.ts': 4487,
  // 4232→4237 (#1000 heatmap relocate): the heatmap density-target OWNERSHIP
  // extracted to render/heatmap-targets.ts; map keeps only the irreducible
  // composition-root wiring — the `heatmapTargets` field + its import (mirrors
  // the `_paletteHandles` / `renderTargets` owner fields). Lower as #991 shrinks map.ts.
  'map/src/map.ts': 4236,
  'map/src/text/text-stage.ts': 1920,
  'map/src/render/passes/label-pass.ts': 1786,
  'map/src/render/pipeline-factory.ts': 1458,
  'map/src/camera/camera.ts': 1419,
  'map/src/shaders/dsl/line.ts': 1373,
  'map/src/shaders/dsl/polygon.ts': 1315,
  'data/src/tile-catalog.ts': 1290,
  'map/src/render-loop.ts': 1173,
  'map/src/render/point-renderer.ts': 1140,
  'rhi-webgl2/src/rhi-webgl2.ts': 1106,
  'map/src/render/renderer.ts': 965,
  'map/src/render/gpu-tile-store.ts': 941,
  'map/src/render/tile-selection-cache.ts': 930,
  'map/src/render/upload-coordinator.ts': 870,
  'map/src/shaders/dsl/projections.ts': 811,
}

describe('LOC ceiling ratchet: map/engine/geo/data/rhi* god-files shrink-only (#1003)', () => {
  it('no baselined god-file exceeds its locked ceiling', () => {
    const grown = Object.entries(CEILINGS)
      .filter(([p]) => exists(join(ROOT, p)))
      .map(([p, ceil]) => ({ p, n: lineCount(join(ROOT, p)), ceil }))
      .filter((x) => x.n > x.ceil)
      .map(
        (x) => `${x.p}: ${x.n} > ceiling ${x.ceil} — extract, don't grow (then lower the ceiling)`,
      )
    expect(grown, grown.join('\n')).toEqual([])
  })

  it('no CEILINGS entry is stale (every key still exists — the #996 vacuity guard)', () => {
    const stale = Object.keys(CEILINGS)
      .filter((p) => !exists(join(ROOT, p)))
      .map((p) => `${p} — file moved/deleted; delete or repoint this stale ceiling`)
    expect(stale, stale.join('\n')).toEqual([])
  })

  it(`no non-baselined source file exceeds ${NEW_FILE_CAP} LOC`, () => {
    const tooBig: string[] = []
    for (const pk of PKGS) {
      for (const f of walkTs(join(ROOT, pk))) {
        const r = rel(f)
        if (r in CEILINGS) continue
        const n = lineCount(f)
        if (n > NEW_FILE_CAP)
          tooBig.push(`${r}: ${n} > ${NEW_FILE_CAP} — split it before it becomes a god-file`)
      }
    }
    expect(tooBig, tooBig.join('\n')).toEqual([])
  })
})

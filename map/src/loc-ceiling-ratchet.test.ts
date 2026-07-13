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
  // #1005 — carried from the retiring runtime arch-invariants Gate 3, whose
  // SRC_DIRS walk covered these three trees; without this they go ceiling-dark
  // the day runtime/ is deleted. Ceilings re-measured at carry time (several
  // files had shrunk below their old runtime ceilings — the tighter value won).
  'compiler/src',
  'blueprint/src',
  'shared/src',
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
  // 4236→4216 (cast audit): the heatmap show build extracted to heatmap-show.ts;
  // the rebuild loop keeps only the loop-top routing + one call.
  'map/src/map.ts': 4216,
  // 1920→1930 (#1042 R3): the globe limb cull for MULTI-LINE labels must land in
  // the collision phase — the ONLY site holding the label's quad half-height (the
  // collision box IS the height authority; the label-pass dispatch site has only
  // the unresolved TextValue). +10 = the `limbInset` prepare() param + the
  // box-height gate at collisionInput. An 8-line predicate isn't extract-worthy (§2).
  // 1930→1941 (#1081): the point-loop folds the per-anchor perspectiveScale into
  // sizePx — the SINGLE quad authority, so the collision box AND the draw quad
  // scale together (and the #1042 R3 limb gate then compares the SCALED half-
  // height). +11 = the sizePx fold (quantised 1/64 for layout-cache stability) +
  // addLabel's perspScale param/push. Inline in the hot loop; not extract-worthy (§2).
  'map/src/text/text-stage.ts': 1941,
  // 1786→1719 (#727 C): the line/point dedupe + pair-key helper block was
  // EXTRACTED to passes/line-label-dedupe.ts when the world-copy fan-out would
  // otherwise have grown this file — the extract-don't-grow answer.
  // 1719→1726 (#1081): thread the projector's per-copy perspScale (projectLonLat
  // Copies tuple slot 3) into the point-label addLabel + dispatchIcon, plus
  // dispatchIcon's own perspScale param → addIcon. +7, all at existing call sites.
  'map/src/render/passes/label-pass.ts': 1726,
  // #1081 — per-anchor perspective distance attenuation (MapLibre parity). New
  // baseline: the wCenter + perspScale scratch-out-value lives INLINE in the two
  // existing projector closures (it rides the cw already computed per anchor —
  // not extract-worthy, §2), plus the perspectiveScale() getter, the 3-slot
  // projectLonLatCopies tuple, and the 6-member return objects prettier now wraps
  // multi-line — together nudging this helper just over NEW_FILE_CAP (773→818).
  'map/src/render-loop-helpers.ts': 818,
  'map/src/render/pipeline-factory.ts': 1458,
  'map/src/camera/camera.ts': 1419,
  'map/src/shaders/dsl/line.ts': 1373,
  'map/src/shaders/dsl/polygon.ts': 1315,
  'data/src/tile-catalog.ts': 1290,
  'map/src/render-loop.ts': 1173,
  'map/src/render/point-renderer.ts': 1140,
  // 1106→1120 (#1043 state-hygiene): three unmask-before-clear / state-reset fixes for the
  // WebGL2 flicker class — beginScreenPass colorMask unmask (the colour sibling of #746/#780),
  // dispatchComputeToR32UI viewport snapshot+restore, and the setPipeline no-depth arm's
  // POLYGON_OFFSET_FILL reset. Each is a documented comment + one GL call (net +14).
  'rhi-webgl2/src/rhi-webgl2.ts': 1120,
  'map/src/render/renderer.ts': 965,
  'map/src/render/gpu-tile-store.ts': 941,
  'map/src/render/tile-selection-cache.ts': 930,
  'map/src/render/upload-coordinator.ts': 870,
  'map/src/shaders/dsl/projections.ts': 811,
  // #1005 — carried from the runtime arch-invariants Gate 3 (re-measured
  // 2026-07-13; lower.ts had shrunk 1452→1409, the tighter value carried).
  'compiler/src/tiler/vector-tiler.ts': 1790,
  'compiler/src/ir/lower.ts': 1409,
  'compiler/src/convert/layers-symbol.ts': 1295,
  'compiler/src/ir/lower-label.ts': 1091,
  'compiler/src/tokens/colors.ts': 937,
  'compiler/src/ir/render-node.ts': 908,
  'compiler/src/convert/paint-helpers.ts': 826,
  'blueprint/src/editor.ts': 1448,
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

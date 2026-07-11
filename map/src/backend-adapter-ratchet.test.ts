// ═══ Backend-adapter coupling ratchet — @xgis/map stays backend-NEUTRAL ═══
//
// Second axis of the #991 charter (companion to raw-webgpu-ratchet.test.ts). That
// gate bans native `GPU*` in map; THIS one bans map reaching directly into a
// CONCRETE backend adapter — `@xgis/rhi-webgpu` / `@xgis/rhi-webgl2` — for anything
// but composition-root backend selection.
//
// WHY this is its own gate. map is the content layer; it should render through the
// NEUTRAL RHI (`@xgis/engine`, which re-exports `@xgis/rhi`) and obtain an opaque
// `RhiDevice`, so the concrete backend (WebGPU vs WebGL2) is chosen ONCE — a single
// engine-config switch (`BackendChoice` = the public `XGISMapOptions.backend`), the
// way a game engine picks its renderer. Today map instead imports ~56 backend-
// specific symbols straight from `@xgis/rhi-webgpu` (`wrapWebGpu*`, `RenderTargets`,
// `GPUTimer`, `ComputeDispatcher`, `StagingBufferPool`, `toVertexBufferLayout`, …)
// and ZERO from `@xgis/rhi-webgl2` — i.e. those paths are hard-wired to WebGPU, so
// switching backends would have to be controlled all over map, defeating the RHI.
// Every `wrapWebGpu*` is proof map still holds a raw GPU object it wraps at the
// boundary; once it creates via `rhi.create*` (neutral, returns an `Rhi*` handle)
// the wrap — and the import — vanish.
//
// Not caught elsewhere. The #929 dependency-direction ratchet deliberately ALLOWS
// `map → rhi-webgpu`/`rhi-webgl2` (map is the composition root), and the raw-webgpu
// ratchet only counts native `GPU*`. So this coupling is otherwise UN-gated — the
// same "un-enforced boundary drifts" gap the raw-webgpu ratchet closed for its axis.
//
// Burn-down. Each EPIC phase moves a cluster behind the neutral RHI and lowers the
// matching rows here IN THE SAME COMMIT (STRICT shrink-only, mirroring #929):
//   wrapWebGpu*            → P6 (device.createX + wrap  ->  rhi.createX)
//   RenderTargets/GPUContext → P4 (G3) / 0.4     GPUTimer → P7 (G8)
//   ComputeDispatcher      → P7 (G7)       StagingBufferPool/asyncWriteBuffer → P7 (G5)
//   resizeCanvas           → P4 (G2)       uploadPalette/palette → 0.3
//   toVertexBufferLayout/uniformFieldSlots/reflection helpers → relocate to engine/rhi
// map.ts keeps an irreducible composition-root minimum (concrete-device boot /
// backendProviderChain) until the app-shell owns device creation; that residue is
// the last to shrink, not a reason to widen the gate.
//
// STRICT-equal, both directions (see raw-webgpu-ratchet.test.ts for the rationale):
// `> baseline` = new coupling (route via @xgis/engine); `< baseline` = win not
// locked (lower it here in the same commit). GPU-free; rides the `test (map)` leg.
// Baseline measured 2026-07-11: 56 imports / 36 files; #1000 relocated the palette
// upload's import off map.ts (5→4) into render/palette-textures.ts (+1) — 56 / 37,
// net-neutral. Target: the map.ts boot floor.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAP_SRC = join(ROOT, 'map/src')

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
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// import/export ... from '@xgis/rhi-webgpu' | '@xgis/rhi-webgl2' (incl. dynamic import()).
const ADAPTER_RE = /(?:from|import)\s*(?:\(\s*)?['"]@xgis\/rhi-webg(?:pu|l2)['"]/g

function adapterImportCount(abs: string): number {
  return (stripComments(readFileSync(abs, 'utf8')).match(ADAPTER_RE) || []).length
}

// Per-file count of direct concrete-backend-adapter imports. SHRINK-ONLY: a phase
// that routes a file through the neutral @xgis/engine RHI lowers its number (0 =
// delete the entry) in the same commit. Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {
  'map/src/geojson-polar-cap-show.ts': 1,
  'map/src/interaction-controller.ts': 1,
  'map/src/map.ts': 4,
  'map/src/render-loop.ts': 1,
  'map/src/render/compose-pipelines.ts': 1,
  'map/src/render/compute-layer-handle.ts': 2,
  'map/src/render/compute-layer-registry.ts': 1,
  'map/src/render/feature-data-binder.ts': 1,
  'map/src/render/frame-context.ts': 1,
  'map/src/render/frame-renderer.ts': 3,
  'map/src/render/graticule-renderer.ts': 1,
  'map/src/render/heatmap-renderer.ts': 1,
  'map/src/render/heatmap-uniform-slots.ts': 1,
  'map/src/render/line-renderer.ts': 3,
  'map/src/render/line-uniform-slots.ts': 1,
  'map/src/render/material/heatmap-material.ts': 1,
  'map/src/render/material/icon-material.ts': 1,
  'map/src/render/material/line-composite-material.ts': 1,
  'map/src/render/material/line-material.ts': 1,
  'map/src/render/material/polygon-fill-material.ts': 1,
  'map/src/render/material/raster-material.ts': 1,
  'map/src/render/material/text-material.ts': 1,
  // Palette upload content relocated here from @xgis/rhi-webgpu (#1000): it drives
  // the backend's generic data-texture primitive with the packed palette bytes.
  // The import moved off map.ts (5→4) — net-neutral, not new coupling. Routing the
  // palette upload through the neutral RHI (0 here) is the future 0.3 phase.
  'map/src/render/palette-textures.ts': 1,
  'map/src/render/passes/graphics-pass.ts': 1,
  'map/src/render/pipeline-factory.ts': 3,
  'map/src/render/point-renderer.ts': 3,
  'map/src/render/polygon-uniform-slots.ts': 1,
  'map/src/render/raster-renderer.ts': 2,
  'map/src/render/raster-uniform-slots.ts': 1,
  'map/src/render/renderer.ts': 1,
  'map/src/render/tile-compute-resources.ts': 1,
  'map/src/render/upload-coordinator.ts': 2,
  'map/src/render/vector-tile-renderer.ts': 4,
  'map/src/source-manager.ts': 1,
  'map/src/sprite/host-sprite-atlas-gpu.ts': 1,
  'map/src/sprite/icon-renderer.ts': 2,
  'map/src/text/text-renderer.ts': 2,
}

describe('backend-adapter ratchet: map/src imports the concrete backend only at the root (#991)', () => {
  it('per-file @xgis/rhi-webgpu|webgl2 import count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const abs of walkTs(MAP_SRC)) {
      const n = adapterImportCount(abs)
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
          `${f}: ${a} backend-adapter import(s), not in baseline — import through the neutral ` +
            `@xgis/engine RHI instead; if genuinely composition-root boot, add '${f}': ${a} with a rationale`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (decoupled; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW backend-adapter coupling; route through @xgis/engine, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — coupling removed; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `map/src concrete-backend coupling drifted from the #991 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

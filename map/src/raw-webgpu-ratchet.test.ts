// ═══ Raw-WebGPU ratchet — @xgis/map must route every GPU touch through the RHI ═══
//
// The charter invariant (#991): @xgis/map is the geo/content layer; it holds NO
// raw WebGPU — every GPU touch routes through @xgis/engine's RHI (Rhi* handles),
// never a native `GPU*` type/constant. @xgis/engine enforces its own neutrality by
// COMPILER (`types: []` → any `GPU*` identifier is a compile error). @xgis/map
// CANNOT use that mechanism: it legitimately depends on @xgis/rhi-webgpu at the
// composition root, so `@webgpu/types` is in scope and tsc stays silent on a raw
// leak. The old per-identifier webgpu-neutrality ratchet that WOULD have caught it
// was deleted when engine neutrality moved to the compiler (see
// engine/src/dependency-direction-ratchet.test.ts:12-15 — "Successor to the
// deleted per-identifier webgpu-neutrality ratchet #833 M1"). So today every
// raw-WebGPU leak the #991 EPIC closes is UN-GATED: "leak-closed" is a claim with
// nothing mechanical behind it.
//
// This gate is that mechanism. It seeds the CURRENT raw-WebGPU footprint of
// map/src as a per-file BASELINE and asserts STRICT equality: the EPIC drives this
// to zero, one phase at a time, and each phase's PR must lower the baseline for the
// files it cleans IN THE SAME COMMIT (locking the win). See
// docs/architecture/engine-substrate-migration-991.md §4.
//
// STRICT-equal, not a ceiling. The LOC / projType ratchets fail only on GROWTH
// (`> ceiling`) — low friction, but they permit silent re-growth up to the cap.
// That is exactly the failure the EPIC names ("a leak silently reopened between
// phases would pass CI"). So this ratchet fails BOTH ways, mirroring the #929
// dependency-direction convention ("baseline only shrinks — stale entries must be
// deleted in the same commit"):
//   • actual > baseline → a NEW raw leak. Route it through the RHI. Don't grow the
//     baseline (unless a genuinely new, still-gap-blocked site — then bump with a
//     one-line rationale, same as the #929 baseline).
//   • actual < baseline → you closed leak(s). LOWER the baseline to lock it.
//
// SIGNAL (unambiguous + future-proof). We count, per file, over COMMENT-STRIPPED
// source (this codebase documents GPU* heavily in prose):
//   • every native WebGPU identifier `GPU[A-Z]\w*` (types AND the global-constant
//     namespaces GPUShaderStage / GPUBufferUsage / GPUTextureUsage / GPUMapMode /
//     GPUColorWrite) — the RHI NEVER uses `GPU*` (always `Rhi*`), so this never
//     collides with correct routing, and any gap-fill that later adds an RHI method
//     (e.g. rhi.createComputePipeline) is invisible to it. The native-type
//     declaration is the structural anchor: retype `device: GPUDevice → RhiDevice`
//     and every raw `.createRenderPipeline` on it stops type-checking, forcing the
//     call-site fix — so tracking the type footprint transitively forces the calls.
//   • `unwrapBuffer` — the explicit RhiBuffer→GPUBuffer escape cast (G12), deleted
//     when G4/G5 land.
// EXCLUDED (X-GIS-own `GPU*` identifiers that are NOT native WebGPU): GPUArena* (the
// @xgis/engine bump allocator), GPUTimer (map's profiler class), GPUContext (the
// @xgis/rhi-webgpu wrapper interface), GPUTile* (map's own tile struct).
//
// GPU-free; rides the `test (map)` CI leg (`vitest map/src`). Baseline measured on
// the tree at the #991 P0 branch: 555 tokens / 44 files. Close-out = this map == {}.

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

// Strip block + line comments so the ratchet tracks CODE, not contract prose.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// X-GIS-own GPU-prefixed identifiers — NOT native WebGPU; never counted.
const XGIS_OWN = new Set([
  'GPUArena',
  'GPUArenas',
  'GPUArenaOptions',
  'GPUTimer',
  'GPUContext',
  'GPUTile',
  'GPUTiles',
])
const NATIVE_RE = /\bGPU[A-Z][A-Za-z0-9]*\b/g
const UNWRAP_RE = /\bunwrapBuffer\b/g

function rawWebgpuCount(abs: string): number {
  const code = stripComments(readFileSync(abs, 'utf8'))
  let n = 0
  for (const m of code.matchAll(NATIVE_RE)) if (!XGIS_OWN.has(m[0])) n++
  n += (code.match(UNWRAP_RE) || []).length
  return n
}

// Per-file raw-WebGPU token count. SHRINK-ONLY: an EPIC #991 phase that closes
// leaks in a file lowers its number (to 0 = delete the entry) in the same commit.
// Measured 2026-07-11 (P0 branch). Ordered by path.
const BASELINE: Record<string, number> = {
  'map/src/color-ramp.ts': 6,
  'map/src/debug-flags.ts': 3,
  'map/src/graphics/graphics-manager.ts': 2,
  'map/src/interaction-controller.ts': 9,
  'map/src/map-types.ts': 12,
  'map/src/map.ts': 6,
  'map/src/render-loop-helpers.ts': 1,
  'map/src/render-loop.ts': 3,
  'map/src/render/bind-group-registry.ts': 18,
  'map/src/render/bucket-scheduler.ts': 5,
  'map/src/render/compose-pipelines.ts': 18,
  'map/src/render/compute-layer-handle.ts': 2,
  'map/src/render/compute-layer-registry.ts': 2,
  // render()'s `pass: GPURenderPassEncoder` param + its `as` cast bridged via
  // wrapWebGpuPass — the ONE raw-token pattern raster-renderer/line-renderer carry,
  // gap-blocked until the #991 neutral pass retires the bridge. #1272.
  'map/src/render/coverage-renderer.ts': 2,
  'map/src/render/feature-data-binder.ts': 21,
  'map/src/render/frame-context.ts': 3,
  'map/src/render/frame-renderer.ts': 47,
  'map/src/render/frame-uniform.ts': 5,
  'map/src/render/gpu-tile-store.ts': 7,
  'map/src/render/graticule-renderer.ts': 9,
  // #777 Phase II — HillshadeRenderer mirrors RasterRenderer's tile machinery
  // (GPUTexture cache, GPUDevice, the native GPURenderPassEncoder bridged via
  // wrapWebGpuPass). Same raw-token surface as raster-renderer, gap-blocked until
  // #991 P6 hands the pass chain a neutral RhiRenderPass.
  'map/src/render/hillshade-renderer.ts': 7,
  'map/src/render/heatmap-renderer.ts': 25,
  'map/src/render/line-renderer.ts': 28,
  'map/src/render/material/heatmap-material.ts': 1,
  // #777 Phase II — HillshadeDraper mirrors RasterDraper (GPUTexture/RhiTexture
  // union in the tile + view-cache types, bridged via wrapWebGpuTextureView).
  'map/src/render/material/hillshade-material.ts': 5,
  'map/src/render/material/icon-material.ts': 1,
  'map/src/render/material/line-composite-material.ts': 1,
  'map/src/render/material/line-material.ts': 2,
  'map/src/render/material/polygon-fill-material.ts': 7,
  'map/src/render/material/raster-material.ts': 6,
  'map/src/render/material/text-material.ts': 1,
  'map/src/render/passes/opaque-pass.ts': 1,
  // 82→85 (#1252): the variant data-driven extruded pipeline descriptors
  // (fillExtruded/fallback in both variant builders) name GPURenderPipeline{,Descriptor} —
  // the same raw-WebGPU surface the existing base extruded builders carry.
  'map/src/render/pipeline-factory.ts': 85,
  // 16→15 (#1057 inc2): flushTilePoints's `pass: GPURenderPassEncoder` retyped to
  // `RhiRenderPass` (flushTilePointsRhi) — the wrap moved up to VTR.emitTilePointsRhi.
  'map/src/render/point-renderer.ts': 15,
  'map/src/render/raster-renderer.ts': 8,
  // 20→24 (#1252): CachedPipeline gains 4 GPURenderPipeline fields for the
  // variant data-driven extruded pipelines (mirrors the existing fill/ground fields).
  'map/src/render/renderer-types.ts': 24,
  'map/src/render/renderer.ts': 60,
  'map/src/render/tile-compute-resources.ts': 7,
  // INC-1 under-occluder sphere: a Material/executeItems draw in the opaque pass,
  // which hands a NATIVE GPURenderPassEncoder — the param type is the ONE raw token,
  // bridged via wrapWebGpuPass exactly like raster-renderer/vector-drape/line-renderer.
  // Gap-blocked until #991 P6 makes the pass chain hand a neutral RhiRenderPass.
  'map/src/render/under-occluder-renderer.ts': 1,
  'map/src/render/upload-coordinator.ts': 22,
  'map/src/render/vector-tile-renderer-types.ts': 5,
  'map/src/render/vector-tile-renderer.ts': 20,
  'map/src/sprite/host-sprite-atlas-gpu.ts': 14,
  'map/src/sprite/icon-renderer.ts': 12,
  'map/src/sprite/icon-stage.ts': 8,
  'map/src/sprite/sprite-atlas-gpu.ts': 12,
  'map/src/text/text-renderer.ts': 13,
  'map/src/text/text-stage.ts': 3,
}

describe('raw-WebGPU ratchet: map/src routes GPU through the RHI (#991)', () => {
  it('per-file raw-WebGPU token count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const abs of walkTs(MAP_SRC)) {
      const n = rawWebgpuCount(abs)
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
          `${f}: ${a} raw-WebGPU tokens, not in baseline — route through the @xgis/engine RHI; ` +
            `if genuinely a new gap-blocked site, add '${f}': ${a} with a one-line rationale`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (leak closed; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW raw-WebGPU leak(s); route through the RHI, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — leak(s) closed; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `Raw-WebGPU footprint of map/src drifted from the #991 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

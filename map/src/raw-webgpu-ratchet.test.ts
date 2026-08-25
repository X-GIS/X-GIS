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
  // interaction-controller 9 → 5, map.ts 6 → 5 (#1046 F4 Inc-D): the pick RT
  // rides RhiTexture/RhiDevice through the DI seam — the native tokens left
  // are the readback's own (createBuffer/copyTextureToBuffer/mapAsync, G4).
  'map/src/interaction-controller.ts': 5,
  'map/src/map-types.ts': 12,
  'map/src/map.ts': 5,
  // render-loop-helpers row DELETED (#1046 F4 Inc-A): reportErrorScope takes the
  // RHI's message-or-null promise — the GPUError type reference died with it.
  // compute-layer-handle + compute-layer-registry rows DELETED, five rows lowered
  // (#1046 F4 Inc-C): the compute thread is RHI-typed end-to-end — the one unwrap
  // lives in ComputeDispatcher.dispatchKernelRhi (the adapter).
  'map/src/render/bind-group-registry.ts': 18,
  // #1046 F3b Inc-2d: ShowDrawFn + the chain's remaining pass-consuming
  // signatures narrowed to RhiRenderPass — the backend-keyed re-wrap forks
  // (the 34d4695 double-wrap class) and their unions died with it.
  'map/src/render/bucket-scheduler.ts': 3,
  // #1046 F3b Inc-2c: the heatmap chain re-originated through the RHI drapers —
  // the native accum bridge, blur/compose pipelines + their factory/forwarder
  // layers and the native density-target pair all retired with it.
  'map/src/render/compose-pipelines.ts': 9,
  'map/src/render/feature-data-binder.ts': 19,
  // 43→46 (#1046 F3b Inc-2d): drawOitCompose RELOCATED here from oit-pass
  // (the pipeline/layout owner; native until the OIT twin lands) — moved
  // tokens plus the boundary unwrap cast, retiring with that twin.
  // 44→45 (#2042 INC-4b): the SPLIT_FILL_LAYOUT_ENTRIES static mirror for the
  // drift test (GPUBindGroupLayoutEntry) — same forwarder pattern as PALETTE.
  'map/src/render/frame-renderer.ts': 45,
  'map/src/render/frame-uniform.ts': 5,
  // 7→5 (#1357): the pooled-buffer recycler moved to gpu-buffer-pool.ts, taking
  // its createBuffer + the raw `device` field with it.
  'map/src/render/gpu-tile-store.ts': 5,
  // The recycler's whole job is minting and destroying raw GPUBuffers for the
  // per-tile line/index/outline path — the RHI exposes no pooled-buffer seam to
  // route that through, so these are gap-blocked with gpu-tile-store's.
  'map/src/render/gpu-buffer-pool.ts': 6,
  'map/src/render/graticule-renderer.ts': 9,
  // #777 Phase II — HillshadeRenderer mirrors RasterRenderer's tile machinery
  // (GPUTexture cache, GPUDevice, the native GPURenderPassEncoder bridged via
  // wrapWebGpuPass). Same raw-token surface as raster-renderer, gap-blocked until
  // #991 P6 hands the pass chain a neutral RhiRenderPass.
  // Merge union (#1046 F3b review + #1352): 7→5 — render() narrowed to
  // RhiRenderPass, the native union member + the double-wrap cast died with the
  // backend-keyed adaptation; independently 7→4 — the tile-load return type and
  // the eviction policy moved to raster-cache-budget.ts, shared with
  // raster-renderer. Disjoint removals over the common ancestor sum: 7−2−3.
  // 2→1 (#1623): the WebGPU-only raw-device `loadImageTexture` arm (hillshade's own
  // copy of the fork #1579 closed on raster) was deleted — both backends now load
  // through the RHI, which also deletes the `device: GPUDevice` field the fork was
  // the only reader of. The one remaining token is `GPUTextureFormat` (the `format`
  // field), gap-blocked with the same class this file's other entries are.
  'map/src/render/hillshade-renderer.ts': 1,
  'map/src/render/line-renderer.ts': 21,
  // #777 Phase II — HillshadeDraper mirrors RasterDraper (GPUTexture/RhiTexture
  // union in the tile + view-cache types, bridged via wrapWebGpuTextureView).
  'map/src/render/material/hillshade-material.ts': 5,
  'map/src/render/material/icon-material.ts': 1,
  'map/src/render/material/line-material.ts': 2,
  // 7→9 (#2042 INC-4b): FillRhiState.split carries the factory's native split
  // layout (GPUBindGroupLayout) and recordFillDraw's splitBind param carries the
  // native bind group (GPUBindGroup) — the same boundary tokens the legacy
  // tileBg path already holds; both retire if the Material seam ever grows
  // dynamic-offset-capable RHI layouts.
  'map/src/render/material/polygon-fill-material.ts': 9,
  'map/src/render/material/raster-material.ts': 6,
  'map/src/render/material/text-material.ts': 1,
  // 82→85 (#1252): the variant data-driven extruded pipeline descriptors
  // (fillExtruded/fallback in both variant builders) name GPURenderPipeline{,Descriptor} —
  // the same raw-WebGPU surface the existing base extruded builders carry.
  // 79→82 (#2042 INC-4b): SPLIT_FILL_LAYOUT_ENTRIES + the split layout build
  // (createBindGroupLayout with hasDynamicOffset — inexpressible through the
  // RHI reflect adapter, which never emits dynamic offsets) + the layout field.
  'map/src/render/pipeline-factory.ts': 82,
  // 16→15 (#1057 inc2): flushTilePoints's `pass: GPURenderPassEncoder` retyped to
  // `RhiRenderPass` (flushTilePointsRhi) — the wrap moved up to VTR.emitTilePointsRhi.
  // 15→10 (#1913): buildPointBglEntries' four hand-authored `GPUShaderStage.*` rows
  // collapsed to one `GPUShaderStage` pass-through — `reflectionToBindGroupLayoutEntries`
  // derives per-binding visibility from `BindEntry.stages` and needs only the bit values.
  'map/src/render/point-renderer.ts': 10,
  // raster-cache-budget.ts row DELETED (#1623): 5→0. `LoadedTexture`/`EvictableTile`
  // narrowed to `texture: RhiTexture` (no more `GPUTexture | RhiTexture` union) now that
  // hillshade's raw-device WebGPU arm — the last producer of a raw `GPUTexture` here — is
  // gone, and `destroyTileTexture` dropped the handle-shape discriminant (#1607) it
  // existed for, down to an unconditional `rhi.destroyTexture`.
  // 8→5 (#1352): the loaded-texture return type and the shared eviction moved to
  // raster-cache-budget.ts.
  // 3→2 (#1579): the WebGPU-only raw-device `loadImageTexture` arm (unmipped, bypassed the
  // RHI entirely) was deleted in favour of routing both backends through the RHI create +
  // generateMipmaps path the WebGL2 arm already used.
  'map/src/render/raster-renderer.ts': 2,
  // 20→24 (#1252): CachedPipeline gains 4 GPURenderPipeline fields for the
  // variant data-driven extruded pipelines (mirrors the existing fill/ground fields).
  'map/src/render/renderer-types.ts': 24,
  // 56→58 (#1046 F3b Inc-2d): renderToPass/renderGraticuleOverlay narrowed
  // to RhiRenderPass with one boundary unwrap cast each (legacy plumbing —
  // retires with the legacy-layer cluster).
  'map/src/render/renderer.ts': 56,
  'map/src/render/tile-compute-resources.ts': 5,
  // Baselined 6 (#2042 INC-4b): UniformSplitBind's native half — the split
  // bind group over the two arenas + frame block (GPUDevice/GPUBindGroup/
  // GPUBindGroupLayout/GPUBuffer + one createBindGroup). Gap-blocked: the RHI
  // reflect adapter cannot express hasDynamicOffset layouts, so the group must
  // be built native against the factory's native split layout. Retires with a
  // dynamic-offset-capable RHI bind seam.
  'map/src/render/uniform-split-bind.ts': 6,
  'map/src/render/upload-coordinator.ts': 22,
  'map/src/render/vector-tile-renderer-types.ts': 5,
  // 17→20 (#2042 INC-4b): the splitBind draw type (GPUBindGroup ×2 at the
  // resolve + pass-through) and the unwrapBuffer closure (GPUBuffer) handed to
  // UniformSplitBind — boundary tokens of the same class as ringBufferNative.
  'map/src/render/vector-tile-renderer.ts': 20,
  'map/src/sprite/host-sprite-atlas-gpu.ts': 14,
  'map/src/sprite/icon-renderer.ts': 10,
  'map/src/sprite/icon-stage.ts': 7,
  'map/src/sprite/sprite-atlas-gpu.ts': 12,
  'map/src/text/text-renderer.ts': 11,
  'map/src/text/text-stage.ts': 2,
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

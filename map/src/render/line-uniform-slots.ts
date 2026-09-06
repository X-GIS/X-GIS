// ═══ Line uniform sizes — from the DSL struct handle, not hand-coded ═══
//
// The line shader (shaders/dsl/line.ts) authors TWO uniform structs: `TileUniforms`
// (group 0 — byte-mirrors the polygon Uniforms, 272 B) and `LineLayer` (group 1 —
// the per-layer stroke style block, 208 B). Their byte sizes used to live ONLY as
// hand-coded literals (line-pattern.ts `LINE_UNIFORM_SIZE = 208`, line-renderer.ts
// `LAYER_SLOT = 256`) with no link back to the DSL struct — the exact std140-drift
// class the polygon path retired via polygon-uniform-slots.ts.
//
// `wgslLayout(lineLayerU.struct, 'std140')` recovers the field layout from the SAME
// declaration the WGSL is emitted from, so these helpers are the single source of truth,
// and the consumers derive from them directly: line-pattern.ts's packer scratch is sized
// via lineLayerUniformBytes(), and LineRenderer's ring stride is lineLayerUniformStride()
// (no more literals). line-uniform-reflect-parity.test.ts asserts those RUNTIME values
// equal reflect(buildLineModule()) — a re-hardcode guard, and since #2499 step 4 also the
// proof that the handle-derived layout equals the reflected one.
//
// MODULE-FREE (#2499 step 4): this used to be `reflect(buildLineModule())`, which built the
// module and emitted the projection fns for a layout. Nothing here emits now; the memo stays.

import { wgslLayout } from '@xgis/shader-dsl'
import { lineLayerU, linePatternSlot } from '../shaders/dsl/line'
import { uniformFieldSlotsOf, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _layer: UniformFieldSlots | undefined

/** f32 slot offsets + total slot count of the line `LineLayer` (group 1) uniform
 *  struct, derived from the `lineLayerU` handle. Memoised — the layout is static
 *  (pick-variant-independent: pick only touches the fragment output struct).
 *
 *  `LineLayer` nests `PatternSlot` (`patterns: arrayOf(PatternSlot, 3)`), and a struct
 *  handle only NAMES its nested structs — so the layout engine is handed both decls, the
 *  same map `reflect()` builds from the module's struct list. The parity arm in
 *  uniform-slots-module-free.test.ts is what pins this equal to the reflected layout. */
export function lineLayerUniformSlots(): UniformFieldSlots {
  const structs = new Map([
    [lineLayerU.struct.name, lineLayerU.struct],
    [linePatternSlot.decl.name, linePatternSlot.decl],
  ])
  return (_layer ??= uniformFieldSlotsOf(wgslLayout(lineLayerU.struct, 'std140', structs)))
}

/** Canonical `LineLayer` byte size, handle-derived (= slots × 4). Use wherever code needs
 *  the bind-range `size` or a scratch buffer sized to the layer uniform. */
export function lineLayerUniformBytes(): number {
  return lineLayerUniformSlots().slots * 4
}

/** Dynamic-offset stride for the LineLayer ring: the next 256-multiple ≥ the struct
 *  byte size (WebGPU minUniformBufferOffsetAlignment = 256). Memoised via
 *  lineLayerUniformBytes(). */
export function lineLayerUniformStride(): number {
  return Math.ceil(lineLayerUniformBytes() / 256) * 256
}

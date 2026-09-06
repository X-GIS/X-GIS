// ═══ Polygon uniform f32 slots — from the DSL struct handle, not hand-coded ═══
//
// The polygon/tile 'Uniforms' struct is authored ONCE in the DSL
// (shaders/dsl/polygon.ts). Its std140 byte layout used to be re-derived BY HAND in
// THREE places: the CPU Float32Array packer (vector-tile-renderer's `uf[N]` magic
// indices), and the drift-guard test's parallel `EXPECTED_F32_OFFSET` table + its own
// std140 reimplementation. Those silently drift from the shader (the point path had a
// real `viewport @20 vs @24` bug; see point-uniform-layout.test.ts).
//
// `wgslLayout(polygonU.struct, 'std140')` recovers the field offsets from the SAME
// declaration the WGSL is emitted from, so sourcing the packer's slot indices here makes
// drift structurally impossible. One source of truth (the DSL struct) instead of three.
//
// HANDLE-ONLY, MODULE-FREE (#2499 step 4). This used to be `reflect(buildPolygonModule())`,
// which built the whole module — and, first time in a process, ran the projection fixpoint
// (~16 ms) — to read a struct layout; on a boot where every shader comes from the bake that
// was the last optimizer run left, and it ran for a layout. The memo stays (the layout is
// static); the "never call before configureProjections()" rule no longer applies here.

import { wgslLayout } from '@xgis/shader-dsl'
import { polygonU } from '../shaders/dsl/polygon'
import { uniformFieldSlotsOf, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _slots: UniformFieldSlots | undefined

/** f32 slot offsets (byteOffset / 4) of the polygon 'Uniforms' struct + its total slot
 *  count, derived from the `polygonU` handle. `slot.<field>` is the index the CPU packer
 *  writes at; `slots` sizes the Float32Array. Memoised — the layout is static
 *  (variant-independent; the base module's Uniforms struct is the same for every variant). */
export function polygonUniformSlots(): UniformFieldSlots {
  return (_slots ??= uniformFieldSlotsOf(wgslLayout(polygonU.struct, 'std140')))
}

/** Canonical polygon Uniforms struct byte size, derived from the handle.
 *  = polygonUniformSlots().slots * 4.  Use this wherever code needs the
 *  bind-range `size` or an ArrayBuffer sized to the struct — so a future
 *  struct change propagates automatically without touching every call-site. */
export function polygonUniformBytes(): number {
  return polygonUniformSlots().slots * 4
}

/** Dynamic-offset stride for the polygon Uniforms ring: the next 256-multiple ≥
 *  the struct byte size (WebGPU minUniformBufferOffsetAlignment = 256). Memoised via
 *  polygonUniformBytes(). */
export function polygonUniformStride(): number {
  return Math.ceil(polygonUniformBytes() / 256) * 256
}

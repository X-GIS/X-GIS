// ═══ Polygon uniform f32 slots — sourced from reflect(), not hand-coded ═══
//
// The polygon/tile 'Uniforms' struct is authored ONCE in the DSL
// (shaders/dsl/polygon.ts). Its std140 byte layout used to be re-derived BY HAND in
// THREE places: the CPU Float32Array packer (vector-tile-renderer's `uf[N]` magic
// indices), and the drift-guard test's parallel `EXPECTED_F32_OFFSET` table + its own
// std140 reimplementation. Those silently drift from the shader (the point path had a
// real `viewport @20 vs @24` bug; see point-uniform-layout.test.ts).
//
// reflect(buildPolygonModule()) recovers the field offsets from the SAME IR the WGSL is
// emitted from, so sourcing the packer's slot indices here makes drift structurally
// impossible — exactly what point-renderer already does via uniformFieldSlots(). One
// source of truth (the DSL struct) instead of three.

import { reflect } from '@xgis/shader-dsl'
import { buildPolygonModule } from '@xgis/map'
import { uniformFieldSlots, type UniformFieldSlots } from '@xgis/engine'

let _slots: UniformFieldSlots | undefined

/** f32 slot offsets (byteOffset / 4) of the polygon 'Uniforms' struct + its total slot
 *  count, derived from reflect(buildPolygonModule()). `slot.<field>` is the index the
 *  CPU packer writes at; `slots` sizes the Float32Array. Memoised — the layout is static
 *  (variant-independent; the base module's Uniforms struct is the same for every variant). */
export function polygonUniformSlots(): UniformFieldSlots {
  return (_slots ??= uniformFieldSlots(reflect(buildPolygonModule(null, false)), 'Uniforms'))
}

/** Canonical polygon Uniforms struct byte size, derived from reflect().
 *  = polygonUniformSlots().slots * 4.  Use this wherever code needs the
 *  bind-range `size` or an ArrayBuffer sized to the struct — so a future
 *  struct change propagates automatically without touching every call-site. */
export function polygonUniformBytes(): number {
  return polygonUniformSlots().slots * 4
}

/** Dynamic-offset stride for the polygon Uniforms ring: the next 256-multiple ≥
 *  the struct byte size (WebGPU minUniformBufferOffsetAlignment = 256). Lazy +
 *  memoised via polygonUniformBytes() — like it, callable only AFTER
 *  configureProjections() (so NEVER from a module-level `const` / `static` field;
 *  use it at ctor/draw time). */
export function polygonUniformStride(): number {
  return Math.ceil(polygonUniformBytes() / 256) * 256
}

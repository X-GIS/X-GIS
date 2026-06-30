// ═══ Line uniform sizes — sourced from reflect(), not hand-coded ═══
//
// The line shader (shaders/dsl/line.ts) authors TWO uniform structs: `TileUniforms`
// (group 0 — byte-mirrors the polygon Uniforms, 272 B) and `LineLayer` (group 1 —
// the per-layer stroke style block, 208 B). Their byte sizes used to live ONLY as
// hand-coded literals (line-pattern.ts `LINE_UNIFORM_SIZE = 208`, line-renderer.ts
// `LAYER_SLOT = 256`) with no link back to the DSL struct — the exact std140-drift
// class the polygon path retired via polygon-uniform-slots.ts.
//
// reflect(buildLineModule()) recovers the field layout from the SAME IR the WGSL is
// emitted from, so these helpers are the single source of truth, and the consumers
// now derive from them directly: line-pattern.ts's packer scratch is sized via
// lineLayerUniformBytes(), and LineRenderer's ring stride is lineLayerUniformStride()
// (no more literals). line-uniform-reflect-parity.test.ts asserts those RUNTIME
// values equal reflect — a re-hardcode guard, not a literal-drift guard.
//
// LAZY (like polygonUniform*): reflect(buildLineModule()) EMITS the projection fns,
// which throw until configureProjections() has run — so NEVER call these from a
// module-level `const` / `static` field; use them at ctor / draw / function-body time
// (enforced by no-eager-uniform-reflect.test.ts, which scans this file's consumers).

import { reflect } from '@xgis/shader-dsl'
import { buildLineModule } from '../shaders/dsl/line'
import { uniformFieldSlots, type UniformFieldSlots } from './reflection-to-webgpu'

let _layer: UniformFieldSlots | undefined

/** f32 slot offsets + total slot count of the line `LineLayer` (group 1) uniform
 *  struct, derived from reflect(buildLineModule()). Memoised — the layout is static
 *  (pick-variant-independent: pick only touches the fragment output struct). */
export function lineLayerUniformSlots(): UniformFieldSlots {
  return (_layer ??= uniformFieldSlots(reflect(buildLineModule(false)), 'LineLayer'))
}

/** Canonical `LineLayer` byte size, derived from reflect() (= slots × 4). Use wherever
 *  code needs the bind-range `size` or a scratch buffer sized to the layer uniform. */
export function lineLayerUniformBytes(): number {
  return lineLayerUniformSlots().slots * 4
}

/** Dynamic-offset stride for the LineLayer ring: the next 256-multiple ≥ the struct
 *  byte size (WebGPU minUniformBufferOffsetAlignment = 256). Lazy — same constraint
 *  as lineLayerUniformBytes(). */
export function lineLayerUniformStride(): number {
  return Math.ceil(lineLayerUniformBytes() / 256) * 256
}

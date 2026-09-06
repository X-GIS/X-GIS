// ═══ Heatmap-accum uniform f32 slots — from the DSL struct handle, not hand-coded ═══
//
// Same consolidation as polygon-uniform-slots.ts: the heatmap-accum 'Uniforms' struct
// (heatmap-accum.ts) is the SoT; the CPU packer (heatmap-renderer's `uf[...]`) used to
// hand-code its f32 offsets (16/20/24/28), which drift from the DSL struct. Sourced
// from the `heatmapAccumU` handle here so a struct change reflows mechanically —
// module-free since #2499 step 4 (see polygon-uniform-slots.ts).

import { wgslLayout } from '@xgis/shader-dsl'
import { heatmapAccumU } from '../shaders/dsl/heatmap-accum'
import { uniformFieldSlotsOf, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _slots: UniformFieldSlots | undefined

/** f32 slot offsets of the heatmap-accum 'Uniforms' struct (mvp / proj_params / viewport /
 *  cam_ecef_h / cam_ecef_l), from the `heatmapAccumU` handle. Memoised. */
export function heatmapUniformSlots(): UniformFieldSlots {
  return (_slots ??= uniformFieldSlotsOf(wgslLayout(heatmapAccumU.struct, 'std140')))
}

/** Canonical heatmap-accum 'Uniforms' struct byte size, handle-derived (= slots * 4).
 *  Use for the bind-range `size` + the scratch Float32Array, so a struct change
 *  propagates without hand-bumping the literal (mirrors polygonUniformBytes()). */
export function heatmapUniformBytes(): number {
  return heatmapUniformSlots().slots * 4
}

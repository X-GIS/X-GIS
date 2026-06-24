// ═══ Heatmap-accum uniform f32 slots — from reflect(), not hand-coded ═══
//
// Same consolidation as polygon-uniform-slots.ts: the heatmap-accum 'Uniforms' struct
// (heatmap-accum.ts) is the SoT; the CPU packer (heatmap-renderer's `uf[...]`) used to
// hand-code its f32 offsets (16/20/24/28), which drift from the DSL struct. Sourced
// from reflect(buildHeatmapAccumModule()) here so a struct change reflows mechanically.

import { reflect } from '@xgis/shader-dsl'
import { buildHeatmapAccumModule } from '../shaders/dsl/heatmap-accum'
import { uniformFieldSlots, type UniformFieldSlots } from './reflection-to-webgpu'

let _slots: UniformFieldSlots | undefined

/** f32 slot offsets of the heatmap-accum 'Uniforms' struct (mvp / proj_params / viewport /
 *  cam_ecef_h / cam_ecef_l), from reflect(). Memoised. LAZY caller: buildHeatmapAccumModule
 *  pulls in projection funcs needing configureProjections() (not run at module-load), so the
 *  consumer must defer the first call to render time — see heatmap-renderer's lazy Proxy. */
export function heatmapUniformSlots(): UniformFieldSlots {
  return (_slots ??= uniformFieldSlots(reflect(buildHeatmapAccumModule()), 'Uniforms'))
}

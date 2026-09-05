// ═══ Raster uniform f32 slots — from the DSL struct handles, not hand-coded ═══
//
// Same consolidation as polygon-uniform-slots.ts: the raster global 'Uniforms'
// (group 0) and per-tile 'TileUniforms' (group 1) structs (shaders/dsl/raster.ts)
// are the SoT; the CPU packer (raster-renderer.ts) hand-coded their byte sizes
// (160 / 48) + field offsets, which drift from the DSL struct (the Uniforms
// struct already grew once by hand for #600's globe_eye). Sourced from the
// `rasterU` / `rasterTileU` handles here so a struct change reflows mechanically —
// module-free since #2499 step 4 (see polygon-uniform-slots.ts).

import { wgslLayout } from '@xgis/shader-dsl'
import { rasterTileU, rasterU } from '../shaders/dsl/raster'
import { uniformFieldSlotsOf, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _u: UniformFieldSlots | undefined
let _t: UniformFieldSlots | undefined

/** f32 slot offsets of the raster global 'Uniforms' struct (mvp / proj_params /
 *  raster_params / raster_color0 / raster_color1 / cam_ecef_center / globe_eye),
 *  from the `rasterU` handle. Memoised. */
export function rasterUniformSlots(): UniformFieldSlots {
  return (_u ??= uniformFieldSlotsOf(wgslLayout(rasterU.struct, 'std140')))
}

/** Canonical raster global 'Uniforms' byte size (= slots * 4). */
export function rasterUniformBytes(): number {
  return rasterUniformSlots().slots * 4
}

/** f32 slot offsets of the raster per-tile 'TileUniforms' struct (bounds /
 *  tile_ecef_center / merc_y / grid), from the `rasterTileU` handle. Memoised. */
export function rasterTileSlots(): UniformFieldSlots {
  return (_t ??= uniformFieldSlotsOf(wgslLayout(rasterTileU.struct, 'std140')))
}

/** Canonical raster 'TileUniforms' byte size (= slots * 4). */
export function rasterTileBytes(): number {
  return rasterTileSlots().slots * 4
}

// ═══ Raster uniform f32 slots — from reflect(), not hand-coded ═══
//
// Same consolidation as polygon-uniform-slots.ts: the raster global 'Uniforms'
// (group 0) and per-tile 'TileUniforms' (group 1) structs (shaders/dsl/raster.ts)
// are the SoT; the CPU packer (raster-renderer.ts) hand-coded their byte sizes
// (160 / 48) + field offsets, which drift from the DSL struct (the Uniforms
// struct already grew once by hand for #600's globe_eye). Sourced from
// reflect(buildRasterModule()) here so a struct change reflows mechanically.

import { reflect } from '@xgis/shader-dsl'
import { buildRasterModule } from '@xgis/map'
import { uniformFieldSlots, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _u: UniformFieldSlots | undefined
let _t: UniformFieldSlots | undefined

// pickEnabled only adds a fragment output, not a uniform field — either build
// reflects the same Uniforms / TileUniforms layout, so `false` is canonical.

/** f32 slot offsets of the raster global 'Uniforms' struct (mvp / proj_params /
 *  raster_params / raster_color0 / raster_color1 / cam_ecef_center / globe_eye),
 *  from reflect(). Memoised. LAZY: buildRasterModule pulls in projection funcs
 *  needing configureProjections() (not run at module-load) — call only at
 *  ctor/draw time, NEVER a module-level const / static field. */
export function rasterUniformSlots(): UniformFieldSlots {
  return (_u ??= uniformFieldSlots(reflect(buildRasterModule(false)), 'Uniforms'))
}

/** Canonical raster global 'Uniforms' byte size (= slots * 4). */
export function rasterUniformBytes(): number {
  return rasterUniformSlots().slots * 4
}

/** f32 slot offsets of the raster per-tile 'TileUniforms' struct (bounds /
 *  tile_ecef_center / merc_y / _pad), from reflect(). Memoised. Same lazy rule. */
export function rasterTileSlots(): UniformFieldSlots {
  return (_t ??= uniformFieldSlots(reflect(buildRasterModule(false)), 'TileUniforms'))
}

/** Canonical raster 'TileUniforms' byte size (= slots * 4). */
export function rasterTileBytes(): number {
  return rasterTileSlots().slots * 4
}

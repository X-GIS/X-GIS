// ═══ Hillshade uniform f32 slots — from the DSL struct handle, not hand-coded ═══
//
// Same consolidation as raster-uniform-slots.ts: the hillshade lighting/decode
// 'HillshadeUniforms' (group 0, binding 3) struct (shaders/dsl/hillshade.ts) is
// the SoT; the INC-3 CPU packer derives its byte offsets from the `hillshadeU` handle
// here so a struct change reflows mechanically instead of drifting a hand-coded layout
// — module-free since #2499 step 4 (see polygon-uniform-slots.ts).
//
// The SHARED vertex uniforms ('Uniforms' global + 'TileUniforms' per-tile pool)
// are the raster authorities — the hillshade renderer reuses rasterUniformSlots()
// / rasterTileSlots() (and writeRasterFrameUniform / writeRasterTileUniform) for
// those; only the hillshade lighting struct lives here.

import { wgslLayout } from '@xgis/shader-dsl'
import { hillshadeU } from '../shaders/dsl/hillshade'
import { uniformFieldSlotsOf, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _hs: UniformFieldSlots | undefined

/** f32 slot offsets of the 'HillshadeUniforms' struct (hs_unpack / hs_light /
 *  hs_shadow / hs_highlight / hs_accent / hs_texel), from the `hillshadeU` handle.
 *  Memoised. */
export function hillshadeUniformSlots(): UniformFieldSlots {
  return (_hs ??= uniformFieldSlotsOf(wgslLayout(hillshadeU.struct, 'std140')))
}

/** Canonical 'HillshadeUniforms' byte size (= slots * 4). */
export function hillshadeUniformBytes(): number {
  return hillshadeUniformSlots().slots * 4
}

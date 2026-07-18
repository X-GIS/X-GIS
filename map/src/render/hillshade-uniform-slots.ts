// ═══ Hillshade uniform f32 slots — from reflect(), not hand-coded ═══
//
// Same consolidation as raster-uniform-slots.ts: the hillshade lighting/decode
// 'HillshadeUniforms' (group 0, binding 3) struct (shaders/dsl/hillshade.ts) is
// the SoT; the INC-3 CPU packer derives its byte offsets from reflect() here so a
// struct change reflows mechanically instead of drifting a hand-coded layout.
//
// The SHARED vertex uniforms ('Uniforms' global + 'TileUniforms' per-tile pool)
// are the raster authorities — the hillshade renderer reuses rasterUniformSlots()
// / rasterTileSlots() (and writeRasterFrameUniform / writeRasterTileUniform) for
// those; only the hillshade lighting struct lives here.

import { reflect } from '@xgis/shader-dsl'
import { buildHillshadeModule } from '@xgis/map'
import { uniformFieldSlots, type UniformFieldSlots } from '@xgis/rhi-webgpu'

let _hs: UniformFieldSlots | undefined

// pickEnabled only adds a fragment output, not a uniform field — either build
// reflects the same struct layout, so `false` is canonical.

/** f32 slot offsets of the 'HillshadeUniforms' struct (hs_unpack / hs_light /
 *  hs_shadow / hs_highlight / hs_accent / hs_texel), from reflect(). Memoised.
 *  LAZY: buildHillshadeModule pulls in projection funcs needing
 *  configureProjections() (not run at module-load) — call only at ctor/draw
 *  time, NEVER a module-level const / static field. */
export function hillshadeUniformSlots(): UniformFieldSlots {
  return (_hs ??= uniformFieldSlots(reflect(buildHillshadeModule(false)), 'HillshadeUniforms'))
}

/** Canonical 'HillshadeUniforms' byte size (= slots * 4). */
export function hillshadeUniformBytes(): number {
  return hillshadeUniformSlots().slots * 4
}

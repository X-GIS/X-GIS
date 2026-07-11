// ═══════════════════════════════════════════════════════════════════
// Palette → GPU textures (data-viz upload schema)
// ═══════════════════════════════════════════════════════════════════
//
// The DATA-VIZ ownership half of the palette→GPU pipeline (#1000, relocated
// from @xgis/rhi-webgpu). @xgis/map is the content layer, so it owns what a
// palette IS — the four textures, their formats, and the atlas row layout:
//
//   - colorPalette        : 1D rgba8unorm  row, N constant-colour literals
//   - scalarPalette        : 1D r32float   row, N constant-scalar literals
//   - colorGradientAtlas  : 2D rgba16float, one row per gradient, GRADIENT_WIDTH wide
//   - scalarGradientAtlas : 2D r32float,    one row per gradient, GRADIENT_WIDTH wide
//   - gradientMeta         : per-gradient (zMin, zMax, base, _pad) f32 uniform array
//
// It DRIVES the backend's generic `createDataTexture` / `writeDataTexture`
// primitive with the packed bytes; the backend adapter never learns what a
// gradient is. The PURE packing half (zoom-stop gradient evaluation + the
// `PackedPalette` packing, plus GRADIENT_WIDTH) is style-domain math and
// lives in @xgis/compiler's palette-pack (#929 A) — this module only lays the
// already-packed texels out into the schema's textures.

import { GRADIENT_WIDTH, type PackedPalette } from '@xgis/compiler'
import {
  createDataTexture,
  writeDataTexture,
  type DataTexture,
  type DataTextureDevice,
} from '@xgis/rhi-webgpu'

/** GPU-resident palette handles. All four textures are present even when
 *  their pool count is 0 (1×1 stub) so bind-group construction doesn't branch
 *  on emptiness — the shader's textureSampleLevel is simply unreferenced when
 *  there's nothing to sample. */
export interface PaletteTextures {
  colorPalette: DataTexture
  scalarPalette: DataTexture
  colorGradientAtlas: DataTexture
  scalarGradientAtlas: DataTexture
  /** Pool counts — non-zero iff the matching texture has real data.
   *  Shader-gen P3.3 uses these to pick `textureLoad` vs constant fold. */
  counts: {
    colors: number
    scalars: number
    colorGradients: number
    scalarGradients: number
  }
  /** Uniform-buffer-bound metadata for gradient zoom-range / base.
   *  Float32Array shapes: [count × 4] entries (zMin, zMax, base, _pad). */
  colorGradientMeta: Float32Array
  scalarGradientMeta: Float32Array
}

/** Create the four palette textures + populate from `packed`. Caller is
 *  responsible for binding them and destroying via `destroyPalette` when the
 *  Scene reloads.
 *
 *  Empty pools get a 1×1 sentinel texture (no GPU error on tiny uploads) —
 *  saves an `if (count > 0)` guard at every consumer. Constant-colour /
 *  constant-scalar rows always upload their (≥1-texel) packed buffer; the
 *  gradient atlases skip the write when empty (nothing packed for them). */
export function uploadPalette(device: DataTextureDevice, packed: PackedPalette): PaletteTextures {
  const colorW = Math.max(packed.colorCount, 1)
  const colorPalette = createDataTexture(device, {
    width: colorW,
    height: 1,
    format: 'rgba8unorm',
    label: 'palette-color',
  })
  writeDataTexture(device, colorPalette, packed.colorBytes, colorW * 4, colorW, 1)

  const scalarW = Math.max(packed.scalarCount, 1)
  const scalarPalette = createDataTexture(device, {
    width: scalarW,
    height: 1,
    format: 'r32float',
    label: 'palette-scalar',
  })
  writeDataTexture(device, scalarPalette, packed.scalarF32, scalarW * 4, scalarW, 1)

  // rgba16float: 8 bytes per texel (4 half-floats). HW linear filter works
  // out-of-the-box (rgba16float is filterable without the float32-filterable
  // feature flag). Bind-group layout's `sampleType: 'float'` covers both
  // rgba8unorm + rgba16float.
  const colorGradientAtlas = createDataTexture(device, {
    width: GRADIENT_WIDTH,
    height: Math.max(packed.colorGradientCount, 1),
    format: 'rgba16float',
    label: 'palette-color-gradient',
  })
  if (packed.colorGradientCount > 0) {
    writeDataTexture(
      device,
      colorGradientAtlas,
      packed.colorGradientBytes,
      GRADIENT_WIDTH * 8,
      GRADIENT_WIDTH,
      packed.colorGradientCount,
    )
  }

  const scalarGradientAtlas = createDataTexture(device, {
    width: GRADIENT_WIDTH,
    height: Math.max(packed.scalarGradientCount, 1),
    format: 'r32float',
    label: 'palette-scalar-gradient',
  })
  if (packed.scalarGradientCount > 0) {
    writeDataTexture(
      device,
      scalarGradientAtlas,
      packed.scalarGradientF32,
      GRADIENT_WIDTH * 4,
      GRADIENT_WIDTH,
      packed.scalarGradientCount,
    )
  }

  return {
    colorPalette,
    scalarPalette,
    colorGradientAtlas,
    scalarGradientAtlas,
    counts: {
      colors: packed.colorCount,
      scalars: packed.scalarCount,
      colorGradients: packed.colorGradientCount,
      scalarGradients: packed.scalarGradientCount,
    },
    colorGradientMeta: packed.colorGradientMeta,
    scalarGradientMeta: packed.scalarGradientMeta,
  }
}

/** Destroy every texture owned by a PaletteTextures handle. Safe to call
 *  multiple times — `.destroy()` is idempotent on already-destroyed textures
 *  per WebGPU spec. */
export function destroyPalette(textures: PaletteTextures): void {
  textures.colorPalette.destroy()
  textures.scalarPalette.destroy()
  textures.colorGradientAtlas.destroy()
  textures.scalarGradientAtlas.destroy()
}

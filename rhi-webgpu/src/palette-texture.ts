// ═══════════════════════════════════════════════════════════════════
// Palette → GPU storage textures (upload half)
// ═══════════════════════════════════════════════════════════════════
//
// The IMPURE half of the palette→GPU pipeline: create textures + call
// writeTexture for a `PackedPalette`, returning a PaletteTextures
// handle. The PURE half (zoom-stop gradient evaluation + packing —
// style-domain math) lives in @xgis/compiler's palette-pack (#929 A):
// this backend only uploads packed texels and never learns what a
// zoom is.
//
//   - colorPalette       : 1D RGBA8 row,    N color literals
//   - scalarPalette      : 1D r32float row, N scalar literals
//   - colorGradientAtlas : 2D rgba16float, one row per gradient, GRADIENT_WIDTH wide
//   - scalarGradientAtlas: 2D r32float, one row per gradient, GRADIENT_WIDTH wide
//   - gradientMeta       : per-gradient (zMin, zMax, base, _pad) f32 uniform array

import { GRADIENT_WIDTH, type PackedPalette } from '@xgis/compiler'

/** GPU-resident palette handles. All four textures are present even
 *  when their pool count is 0 (1×1 stub) so bind-group construction
 *  doesn't branch on emptiness — the shader's textureSampleLevel
 *  is simply unreferenced when there's nothing to sample. */
export interface PaletteTextures {
  colorPalette: GPUTexture
  scalarPalette: GPUTexture
  colorGradientAtlas: GPUTexture
  scalarGradientAtlas: GPUTexture
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

/** Create the four palette textures + populate from `packed`.
 *  Caller is responsible for binding them and destroying via
 *  `destroyPalette` when the Scene reloads.
 *
 *  Empty pools get a 1×1 sentinel texture (no GPU error on tiny
 *  uploads) — saves an `if (count > 0)` guard at every consumer. */
export function uploadPalette(device: GPUDevice, packed: PackedPalette): PaletteTextures {
  const make2D = (w: number, h: number, format: GPUTextureFormat, label: string): GPUTexture =>
    device.createTexture({
      label,
      size: { width: Math.max(w, 1), height: Math.max(h, 1) },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

  const colorPalette = make2D(Math.max(packed.colorCount, 1), 1, 'rgba8unorm', 'palette-color')
  device.queue.writeTexture(
    { texture: colorPalette },
    packed.colorBytes,
    { bytesPerRow: Math.max(packed.colorCount, 1) * 4 },
    { width: Math.max(packed.colorCount, 1), height: 1 },
  )

  const scalarPalette = make2D(Math.max(packed.scalarCount, 1), 1, 'r32float', 'palette-scalar')
  device.queue.writeTexture(
    { texture: scalarPalette },
    packed.scalarF32,
    { bytesPerRow: Math.max(packed.scalarCount, 1) * 4 },
    { width: Math.max(packed.scalarCount, 1), height: 1 },
  )

  // rgba16float: 8 bytes per texel (4 half-floats). HW linear filter
  // works out-of-the-box (rgba16float is filterable without the
  // float32-filterable feature flag). Bind-group layout's
  // `sampleType: 'float'` covers both rgba8unorm + rgba16float.
  const colorGradientAtlas = make2D(
    GRADIENT_WIDTH,
    Math.max(packed.colorGradientCount, 1),
    'rgba16float',
    'palette-color-gradient',
  )
  if (packed.colorGradientCount > 0) {
    device.queue.writeTexture(
      { texture: colorGradientAtlas },
      packed.colorGradientBytes,
      { bytesPerRow: GRADIENT_WIDTH * 8 },
      { width: GRADIENT_WIDTH, height: packed.colorGradientCount },
    )
  }

  const scalarGradientAtlas = make2D(
    GRADIENT_WIDTH,
    Math.max(packed.scalarGradientCount, 1),
    'r32float',
    'palette-scalar-gradient',
  )
  if (packed.scalarGradientCount > 0) {
    device.queue.writeTexture(
      { texture: scalarGradientAtlas },
      packed.scalarGradientF32,
      { bytesPerRow: GRADIENT_WIDTH * 4 },
      { width: GRADIENT_WIDTH, height: packed.scalarGradientCount },
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

/** Destroy every texture owned by a PaletteTextures handle. Safe to
 *  call multiple times — `GPUTexture.destroy()` is idempotent on
 *  already-destroyed textures per WebGPU spec. */
export function destroyPalette(textures: PaletteTextures): void {
  textures.colorPalette.destroy()
  textures.scalarPalette.destroy()
  textures.colorGradientAtlas.destroy()
  textures.scalarGradientAtlas.destroy()
}

// ═══════════════════════════════════════════════════════════════════
// Palette → GPU storage textures
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 3 step 2 (wild-finding-starlight). Consumes the
// compile-time `Palette` (from compiler/src/codegen/palette.ts) and
// produces GPU-resident storage textures:
//
//   - colorPalette       : 1D RGBA8 row,    N color literals
//   - scalarPalette      : 1D r32float row, N scalar literals
//   - colorGradientAtlas : 2D RGBA8,    one row per gradient, GRADIENT_WIDTH wide
//   - scalarGradientAtlas: 2D r32float, one row per gradient, GRADIENT_WIDTH wide
//   - gradientMeta       : per-gradient (zMin, zMax, base, _pad) f32 uniform array
//
// Each gradient texel pre-bakes the linear- or exponential-curve
// interpolation between its two flanking stops, so the runtime shader
// can read a per-zoom color/scalar with a single textureSampleLevel
// call — no per-frame stop search, no per-frame uniform writeBuffer.
//
// What this module does NOT do (yet):
//
//   - Bind to a specific tier of the bind-group hierarchy. P2 (4-tier
//     bind groups) decides the actual binding. Step 2 ships the
//     producer + a thin "create + writeTexture" API; the consumer
//     (shader-gen P3.3 + runtime P3.4) wires them in.
//   - Hot-reload / mutation. P6 (DOM-style setPaintProperty) layers
//     a writeTexture-by-cell fast path on top of this module.
//
// Pure vs impure split:
//
//   - `packPalette(palette, opts)` is PURE. Walks the Palette, emits
//     Uint8Array / Float32Array buffers + metadata. Unit-testable
//     without a GPUDevice.
//   - `uploadPalette(device, packed)` is the GPU side. Creates
//     textures, calls writeTexture, returns a PaletteTextures handle.

import type { Palette, ColorGradient, ScalarGradient } from '@xgis/compiler'

/** Texels per gradient row. 256 covers Mapbox's typical zoom range
 *  (0..22) at ~12 texels per integer zoom level. HW linear filtering
 *  smooths the inter-texel residual, so 256 is visually indistinct
 *  from a stop-search evaluation. Power-of-two simplifies texture
 *  allocation alignment. */
export const GRADIENT_WIDTH = 256

/** Bytes per gradient meta entry. (zMin, zMax, base, _pad) f32 ×4. */
export const GRADIENT_META_STRIDE_F32 = 4

// ─── Packed (pre-GPU) representation ───────────────────────────────

/** CPU-side packed buffers ready for `device.queue.writeTexture`. */
export interface PackedPalette {
  /** Width = colors.length, height = 1, format = rgba8unorm. Empty when
   *  no constant colors were collected (e.g., a Scene with only
   *  data-driven fills). */
  colorBytes: Uint8Array
  colorCount: number
  /** Width = scalars.length, height = 1, format = r32float. */
  scalarF32: Float32Array
  scalarCount: number
  /** Width = GRADIENT_WIDTH, height = colorGradients.length,
   *  format = rgba8unorm. Each row is one zoom-stop ramp pre-baked
   *  to GRADIENT_WIDTH texels. */
  colorGradientBytes: Uint8Array
  colorGradientCount: number
  /** Width = GRADIENT_WIDTH, height = scalarGradients.length,
   *  format = r32float. */
  scalarGradientF32: Float32Array
  scalarGradientCount: number
  /** Per-gradient (zMin, zMax, base, _pad) ×4 f32. Indexed by the
   *  gradient's row index. Color and scalar gradients share the same
   *  layout but live in separate uniform arrays — keep them split so
   *  the shader can pick the right one without an extra branch. */
  colorGradientMeta: Float32Array
  scalarGradientMeta: Float32Array
}

// ─── Gradient evaluation ───────────────────────────────────────────

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** Mapbox-spec curve. `base === 1` is linear; `base !== 1` is
 *  `["interpolate", ["exponential", base], …]` — see Mapbox's
 *  interpolation-curves doc. The runtime evaluation matches what
 *  MapLibre / mapbox-gl-js compute at the same (zoom, stops, base). */
function curveFraction(t: number, base: number): number {
  if (base === 1 || Math.abs(base - 1) < 1e-6) return t
  // (base^t - 1) / (base^t1 - 1)  with t in [0,1] and t1=1.
  // Re-derive with denom base-1 (closed form when t1=1).
  const denom = base - 1
  return (Math.pow(base, t) - 1) / denom
}

function lerpRgba(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ]
}

/** Evaluate a color gradient at a normalised position [0,1] mapped
 *  between the gradient's zoom min and max. Public for unit tests. */
export function evalColorGradientAt(
  g: ColorGradient,
  zoom: number,
): [number, number, number, number] {
  const stops = g.stops
  if (stops.length === 0) return [0, 0, 0, 0]
  if (stops.length === 1 || zoom <= stops[0]!.zoom) {
    const v = stops[0]!.value
    return [v[0], v[1], v[2], v[3]]
  }
  if (zoom >= stops[stops.length - 1]!.zoom) {
    const v = stops[stops.length - 1]!.value
    return [v[0], v[1], v[2], v[3]]
  }
  // Find the bracketing pair. Linear search — N is tiny (≤ ~10).
  let i = 0
  while (i < stops.length - 1 && stops[i + 1]!.zoom <= zoom) i++
  const lo = stops[i]!
  const hi = stops[i + 1]!
  const t = (zoom - lo.zoom) / (hi.zoom - lo.zoom)
  return lerpRgba(lo.value, hi.value, curveFraction(t, g.base))
}

export function evalScalarGradientAt(g: ScalarGradient, zoom: number): number {
  const stops = g.stops
  if (stops.length === 0) return 0
  if (stops.length === 1 || zoom <= stops[0]!.zoom) return stops[0]!.value
  if (zoom >= stops[stops.length - 1]!.zoom) return stops[stops.length - 1]!.value
  let i = 0
  while (i < stops.length - 1 && stops[i + 1]!.zoom <= zoom) i++
  const lo = stops[i]!
  const hi = stops[i + 1]!
  const t = (zoom - lo.zoom) / (hi.zoom - lo.zoom)
  return lo.value + (hi.value - lo.value) * curveFraction(t, g.base)
}

// ─── Packing ───────────────────────────────────────────────────────

function gradientZRange(stops: readonly { zoom: number }[]): [number, number] {
  if (stops.length === 0) return [0, 1]
  return [stops[0]!.zoom, stops[stops.length - 1]!.zoom]
}

function bakeColorGradient(g: ColorGradient, out: Uint8Array, rowByteOffset: number): void {
  const [zMin, zMax] = gradientZRange(g.stops)
  const span = zMax - zMin || 1
  for (let i = 0; i < GRADIENT_WIDTH; i++) {
    const t = i / (GRADIENT_WIDTH - 1)
    const zoom = zMin + t * span
    const [r, gC, b, a] = evalColorGradientAt(g, zoom)
    const px = rowByteOffset + i * 4
    out[px] = Math.round(clamp01(r) * 255)
    out[px + 1] = Math.round(clamp01(gC) * 255)
    out[px + 2] = Math.round(clamp01(b) * 255)
    out[px + 3] = Math.round(clamp01(a) * 255)
  }
}

function bakeScalarGradient(g: ScalarGradient, out: Float32Array, rowF32Offset: number): void {
  const [zMin, zMax] = gradientZRange(g.stops)
  const span = zMax - zMin || 1
  for (let i = 0; i < GRADIENT_WIDTH; i++) {
    const t = i / (GRADIENT_WIDTH - 1)
    const zoom = zMin + t * span
    out[rowF32Offset + i] = evalScalarGradientAt(g, zoom)
  }
}

/** PURE: walk the Palette, produce typed-array buffers + metadata
 *  ready for GPU upload. Idempotent — calling multiple times on the
 *  same Palette returns byte-identical PackedPalettes. */
export function packPalette(palette: Palette): PackedPalette {
  const colorCount = palette.colors.length
  const colorBytes = new Uint8Array(Math.max(colorCount, 1) * 4)
  for (let i = 0; i < colorCount; i++) {
    const [r, g, b, a] = palette.colors[i]!
    const o = i * 4
    colorBytes[o] = Math.round(clamp01(r) * 255)
    colorBytes[o + 1] = Math.round(clamp01(g) * 255)
    colorBytes[o + 2] = Math.round(clamp01(b) * 255)
    colorBytes[o + 3] = Math.round(clamp01(a) * 255)
  }

  const scalarCount = palette.scalars.length
  const scalarF32 = new Float32Array(Math.max(scalarCount, 1))
  for (let i = 0; i < scalarCount; i++) scalarF32[i] = palette.scalars[i]!

  const colorGradientCount = palette.colorGradients.length
  const colorGradientBytes = new Uint8Array(Math.max(colorGradientCount, 1) * GRADIENT_WIDTH * 4)
  const colorGradientMeta = new Float32Array(Math.max(colorGradientCount, 1) * GRADIENT_META_STRIDE_F32)
  for (let i = 0; i < colorGradientCount; i++) {
    const g = palette.colorGradients[i]!
    bakeColorGradient(g, colorGradientBytes, i * GRADIENT_WIDTH * 4)
    const [zMin, zMax] = gradientZRange(g.stops)
    colorGradientMeta[i * GRADIENT_META_STRIDE_F32] = zMin
    colorGradientMeta[i * GRADIENT_META_STRIDE_F32 + 1] = zMax
    colorGradientMeta[i * GRADIENT_META_STRIDE_F32 + 2] = g.base
    colorGradientMeta[i * GRADIENT_META_STRIDE_F32 + 3] = 0
  }

  const scalarGradientCount = palette.scalarGradients.length
  const scalarGradientF32 = new Float32Array(Math.max(scalarGradientCount, 1) * GRADIENT_WIDTH)
  const scalarGradientMeta = new Float32Array(Math.max(scalarGradientCount, 1) * GRADIENT_META_STRIDE_F32)
  for (let i = 0; i < scalarGradientCount; i++) {
    const g = palette.scalarGradients[i]!
    bakeScalarGradient(g, scalarGradientF32, i * GRADIENT_WIDTH)
    const [zMin, zMax] = gradientZRange(g.stops)
    scalarGradientMeta[i * GRADIENT_META_STRIDE_F32] = zMin
    scalarGradientMeta[i * GRADIENT_META_STRIDE_F32 + 1] = zMax
    scalarGradientMeta[i * GRADIENT_META_STRIDE_F32 + 2] = g.base
    scalarGradientMeta[i * GRADIENT_META_STRIDE_F32 + 3] = 0
  }

  return {
    colorBytes, colorCount,
    scalarF32, scalarCount,
    colorGradientBytes, colorGradientCount,
    scalarGradientF32, scalarGradientCount,
    colorGradientMeta, scalarGradientMeta,
  }
}

// ─── GPU upload ────────────────────────────────────────────────────

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

  const colorGradientAtlas = make2D(
    GRADIENT_WIDTH, Math.max(packed.colorGradientCount, 1),
    'rgba8unorm', 'palette-color-gradient',
  )
  if (packed.colorGradientCount > 0) {
    device.queue.writeTexture(
      { texture: colorGradientAtlas },
      packed.colorGradientBytes,
      { bytesPerRow: GRADIENT_WIDTH * 4 },
      { width: GRADIENT_WIDTH, height: packed.colorGradientCount },
    )
  }

  const scalarGradientAtlas = make2D(
    GRADIENT_WIDTH, Math.max(packed.scalarGradientCount, 1),
    'r32float', 'palette-scalar-gradient',
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
    colorPalette, scalarPalette, colorGradientAtlas, scalarGradientAtlas,
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

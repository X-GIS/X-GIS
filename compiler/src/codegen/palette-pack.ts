// ═══════════════════════════════════════════════════════════════════
// Palette → packed texture buffers (pure, CPU-side)
// ═══════════════════════════════════════════════════════════════════
//
// The PURE half of the palette→GPU pipeline, relocated from
// @xgis/rhi-webgpu's palette-texture.ts (#929 A): zoom-stop gradient
// evaluation is STYLE-domain math (Mapbox interpolation curves), so it
// lives beside the Palette collector it consumes — a render backend
// only uploads the packed texels and never learns what a zoom is.
//
//   - `evalColorGradientAt` / `evalScalarGradientAt` reproduce what
//     MapLibre / mapbox-gl-js compute at the same (zoom, stops, base).
//   - `packPalette(palette)` walks the Palette and emits typed-array
//     buffers + metadata, each gradient row pre-baked to
//     GRADIENT_WIDTH texels so the runtime shader reads a per-zoom
//     color/scalar with a single textureSampleLevel — no per-frame
//     stop search, no per-frame uniform writeBuffer.
//
// The impure half (`uploadPalette` / `destroyPalette`) stays in
// @xgis/rhi-webgpu and consumes the `PackedPalette` produced here.

import type { Palette, ColorGradient, ScalarGradient } from './palette'

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
   *  format = rgba16float. Each row is one zoom-stop ramp pre-baked
   *  to GRADIENT_WIDTH texels. Half-float (16-bit) channels keep the
   *  GPU sample's quantisation below MapLibre's exact CPU
   *  interpolation by a sub-1-RGB delta — Plan Step 4 verification. */
  colorGradientBytes: Uint16Array
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

/** Float32 → IEEE-754 half-float (16-bit) bit pattern. Returns the
 *  16-bit unsigned integer that represents the value when stored in
 *  a `rgba16float` texture. Used for the gradient atlas precision
 *  upgrade (rgba8unorm → rgba16float) — 8-bit channels quantised
 *  zoom-interp samples to a 1-RGB delta vs MapLibre's float64
 *  interpolation; half-float's ~11-bit mantissa pushes the delta
 *  below the eyeball + the `≤1 RGB` plan-verification gate. */
function f32ToHalf(val: number): number {
  // Reinterpret the float32 bit pattern; trivial close-form
  // conversion handles the common (non-subnormal, non-NaN) case.
  // Color channels are clamped to [0,1] before reaching here so
  // edge cases (Infinity, NaN) can't occur — input is always a
  // finite small number.
  const buf = new ArrayBuffer(4)
  new Float32Array(buf)[0] = val
  const bits = new Uint32Array(buf)[0]!
  const sign = (bits >>> 16) & 0x8000
  const exp = (bits >>> 23) & 0xff
  const mant = bits & 0x7fffff
  if (exp === 0) return sign // zero / subnormal → zero
  const newExp = exp - 127 + 15
  if (newExp >= 31) return sign | 0x7c00 // overflow → ±Infinity
  if (newExp <= 0) return sign // underflow → zero
  return sign | (newExp << 10) | (mant >>> 13)
}

function bakeColorGradient(g: ColorGradient, out: Uint16Array, rowU16Offset: number): void {
  const [zMin, zMax] = gradientZRange(g.stops)
  const span = zMax - zMin || 1
  for (let i = 0; i < GRADIENT_WIDTH; i++) {
    const t = i / (GRADIENT_WIDTH - 1)
    const zoom = zMin + t * span
    const [r, gC, b, a] = evalColorGradientAt(g, zoom)
    const px = rowU16Offset + i * 4
    out[px] = f32ToHalf(clamp01(r))
    out[px + 1] = f32ToHalf(clamp01(gC))
    out[px + 2] = f32ToHalf(clamp01(b))
    out[px + 3] = f32ToHalf(clamp01(a))
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
  // Uint16Array for rgba16float — 4 half-floats per texel × GRADIENT_WIDTH
  // texels per row. Each row offset is `i * GRADIENT_WIDTH * 4` u16 slots.
  const colorGradientBytes = new Uint16Array(Math.max(colorGradientCount, 1) * GRADIENT_WIDTH * 4)
  const colorGradientMeta = new Float32Array(
    Math.max(colorGradientCount, 1) * GRADIENT_META_STRIDE_F32,
  )
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
  const scalarGradientMeta = new Float32Array(
    Math.max(scalarGradientCount, 1) * GRADIENT_META_STRIDE_F32,
  )
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
    colorBytes,
    colorCount,
    scalarF32,
    scalarCount,
    colorGradientBytes,
    colorGradientCount,
    scalarGradientF32,
    scalarGradientCount,
    colorGradientMeta,
    scalarGradientMeta,
  }
}

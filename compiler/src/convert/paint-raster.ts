// Mapbox `raster` layer paint → xgis utilities. Per-type emitter group
// extracted from paint.ts; called by the thin dispatcher in paint.ts
// in the exact same order. Shared emitters (addOpacity /
// surfaceIgnoredPaint) live in paint-helpers.
import type { MapboxLayer } from './types'
import { addOpacity, surfaceIgnoredPaint, unwrapLiteralNumeric } from './paint-helpers'

/** Unwrap a `["literal", v]` scalar wrapper (string/enum forms). */
function unwrapScalar(v: unknown): unknown {
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  return v
}

/** Emit a constant numeric raster colour-adjustment utility
 *  (`<util>-<N>`, bracket-wrapping negatives so the utility-name lexer
 *  doesn't read the `-` as a segment separator). Only the constant form
 *  is emitted; the spec default (passed as `def`) is silent so an
 *  un-authored property is byte-identical to today. Non-constant
 *  (zoom-interp / data-driven) raster colour forms are rare and warn. */
function addRasterScalar(
  out: string[],
  util: string,
  raw: unknown,
  def: number,
  layerId: string,
  prop: string,
  warnings: string[],
): void {
  if (raw === undefined || raw === null) return
  const v = unwrapLiteralNumeric(raw)
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v === def) return // spec default — no-op, emit nothing
    out.push(v < 0 ? `${util}-[${v}]` : `${util}-${v}`)
    return
  }
  warnings.push(
    `Layer "${layerId}" — paint.${prop}: non-constant form not yet supported for raster colour adjustments — value dropped: ${JSON.stringify(raw).slice(0, 60)}`,
  )
}

export function emitRasterPaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
  // raster-opacity reuses the layer-uniform `opacity` resolver path
  // every other layer type goes through — same interpolate(zoom, …)
  // + constant + data-driven shapes all work. The runtime side
  // multiplies the sampled texel by the resolved opacity in the
  // raster fragment shader so the basemap shaded-relief styles
  // (OFM Liberty's `natural_earth`) fade out at higher zooms the
  // way they do in MapLibre.
  addOpacity(out, p['raster-opacity'], warnings)

  // raster-* colour adjustments → per-show uniforms the raster fragment
  // shader applies in RGB↔HSL (hue-rotate / brightness remap / saturation /
  // contrast). Spec defaults (0 / 0 / 1 / 0 / 0) are a hard no-op and emit
  // nothing, so an un-authored raster show renders byte-identically.
  addRasterScalar(
    out,
    'raster-hue-rotate',
    p['raster-hue-rotate'],
    0,
    layer.id,
    'raster-hue-rotate',
    warnings,
  )
  addRasterScalar(
    out,
    'raster-brightness-min',
    p['raster-brightness-min'],
    0,
    layer.id,
    'raster-brightness-min',
    warnings,
  )
  addRasterScalar(
    out,
    'raster-brightness-max',
    p['raster-brightness-max'],
    1,
    layer.id,
    'raster-brightness-max',
    warnings,
  )
  addRasterScalar(
    out,
    'raster-saturation',
    p['raster-saturation'],
    0,
    layer.id,
    'raster-saturation',
    warnings,
  )
  addRasterScalar(
    out,
    'raster-contrast',
    p['raster-contrast'],
    0,
    layer.id,
    'raster-contrast',
    warnings,
  )

  // raster-resampling (+ MapLibre v3 alias `resampling`): 'linear' (default)
  // matches X-GIS' default sampler; 'nearest' selects a nearest-filtered
  // GPUSampler (pixel-art / DEM staircase). The alias takes the same value
  // space; `raster-resampling` wins if both are present (Mapbox-canonical).
  const rs = unwrapScalar(p['raster-resampling'] ?? p['resampling'])
  if (rs === 'nearest') {
    out.push('raster-resampling-nearest')
  } else if (rs !== undefined && rs !== null && rs !== 'linear') {
    warnings.push(
      `Layer "${layer.id}" — raster-resampling: ${JSON.stringify(rs)} unrecognised; Mapbox spec allows only "linear" | "nearest". Treated as linear.`,
    )
  }

  surfaceIgnoredPaint(layer.id, p, warnings, ['raster-fade-duration'])
}

// Mapbox `hillshade` layer paint → xgis utilities (#777 Phase II). Per-type
// emitter group modelled on paint-raster.ts (`emitRasterPaint` +
// `addRasterScalar`): constant-form emit, spec-default no-op suppression, and
// warn-on-non-constant. Called by the thin dispatcher in paint.ts.
//
// MVP scope (D5): single-source constant forms only. The spec types
// `hillshade-illumination-direction` / `-altitude` as numberArray and
// `hillshade-shadow-color` / `-highlight-color` as colorArray (multidirectional
// / multi-source lighting); a >1-length array warns "multidirectional
// (multi-source) not supported" and uses element 0. Non-constant
// (interpolate / data-driven) forms warn + drop (spec default → suppressed).
import type { MapboxLayer } from './types'
import { colorToXgis } from './colors'
import { unwrapLiteralNumeric } from './paint-helpers'

/** Peel `["literal", v]` wrappers (v8 constant escaping). */
function unwrapLiteral(v: unknown): unknown {
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  return v
}

/** Op strings whose leading token means the array is a SINGLE colour
 *  (tuple / expression), NOT a colorArray of separate colours. */
const COLOR_OR_EXPR_HEADS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'to-color',
  'interpolate',
  'interpolate-hcl',
  'interpolate-lab',
  'match',
  'step',
  'case',
  'coalesce',
  'let',
  'var',
  'get',
  'feature-state',
])

/** Emit a constant numeric hillshade scalar (`hillshade-exaggeration`). The
 *  spec default (`def`) is silent so an un-authored property is byte-identical
 *  to a plain raster-dem draw; non-constant forms warn + drop. Mirror of
 *  `addRasterScalar` (values here are non-negative, so no bracket-wrap). */
function addHillshadeScalar(
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
    out.push(`${util}-${v}`)
    return
  }
  warnings.push(
    `Layer "${layerId}" — paint.${prop}: non-constant form not yet supported for hillshade — value dropped: ${JSON.stringify(raw).slice(0, 60)}`,
  )
}

/** Emit a `numberArray`-typed illumination scalar (direction / altitude). MVP
 *  uses the FIRST source; a >1-length array warns "multidirectional
 *  (multi-source) not supported". Non-constant forms warn + drop. */
function addIlluminationScalar(
  out: string[],
  util: string,
  raw: unknown,
  def: number,
  layerId: string,
  prop: string,
  warnings: string[],
): void {
  if (raw === undefined || raw === null) return
  let v = unwrapLiteral(raw)
  if (Array.isArray(v)) {
    if (v.length > 1) {
      warnings.push(
        `Layer "${layerId}" — paint.${prop}: multidirectional (multi-source) not supported — using the first of ${v.length} directions.`,
      )
    }
    v = v.length > 0 ? unwrapLiteral(v[0]) : undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v === def) return
    out.push(`${util}-${v}`)
    return
  }
  warnings.push(
    `Layer "${layerId}" — paint.${prop}: non-constant form not yet supported for hillshade — value dropped: ${JSON.stringify(raw).slice(0, 60)}`,
  )
}

/** Emit a hillshade colour utility (`<util>-<hex>`). `colorArray` props
 *  (shadow / highlight) accept a multi-source array — warn + use element 0.
 *  The spec default (`defHex`) is silent; a non-constant colour warns via
 *  `colorToXgis` and drops. */
function addHillshadeColor(
  out: string[],
  util: string,
  raw: unknown,
  defHex: string,
  layerId: string,
  prop: string,
  warnings: string[],
  colorArray: boolean,
): void {
  if (raw === undefined || raw === null) return
  let v = unwrapLiteral(raw)
  if (colorArray && Array.isArray(v)) {
    const head = v[0]
    const isSingleColorOrExpr =
      typeof head === 'string' && COLOR_OR_EXPR_HEADS.has(head.toLowerCase())
    if (!isSingleColorOrExpr) {
      // Array OF colours (colorArray) — multi-source lighting.
      if (v.length > 1) {
        warnings.push(
          `Layer "${layerId}" — paint.${prop}: multi-source colour array (multidirectional) not supported — using the first of ${v.length} colours.`,
        )
      }
      v = v.length > 0 ? unwrapLiteral(v[0]) : undefined
    }
  }
  const hex = colorToXgis(v, warnings)
  if (hex === null) return // colorToXgis already warned (non-constant / invalid)
  if (hex.toLowerCase() === defHex.toLowerCase()) return // spec default — suppress
  out.push(`${util}-${hex}`)
}

export function emitHillshadePaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
  // Illumination direction / altitude (numberArray, single-source MVP).
  addIlluminationScalar(
    out,
    'hillshade-illumination-direction',
    p['hillshade-illumination-direction'],
    335,
    layer.id,
    'hillshade-illumination-direction',
    warnings,
  )
  addIlluminationScalar(
    out,
    'hillshade-illumination-altitude',
    p['hillshade-illumination-altitude'],
    45,
    layer.id,
    'hillshade-illumination-altitude',
    warnings,
  )

  // hillshade-illumination-anchor: viewport (default) is byte-identical and
  // emits nothing; map → world-space light anchor flag (mirror of the raster
  // resampling flag).
  const anchor = unwrapLiteral(p['hillshade-illumination-anchor'])
  if (anchor === 'map') {
    out.push('hillshade-illumination-anchor-map')
  } else if (anchor !== undefined && anchor !== null && anchor !== 'viewport') {
    warnings.push(
      `Layer "${layer.id}" — hillshade-illumination-anchor: ${JSON.stringify(anchor)} unrecognised; Mapbox spec allows only "map" | "viewport". Treated as viewport.`,
    )
  }

  addHillshadeScalar(
    out,
    'hillshade-exaggeration',
    p['hillshade-exaggeration'],
    0.5,
    layer.id,
    'hillshade-exaggeration',
    warnings,
  )

  // shadow / highlight (colorArray, single-source MVP) + accent (single color).
  addHillshadeColor(
    out,
    'hillshade-shadow-color',
    p['hillshade-shadow-color'],
    '#000000',
    layer.id,
    'hillshade-shadow-color',
    warnings,
    true,
  )
  addHillshadeColor(
    out,
    'hillshade-highlight-color',
    p['hillshade-highlight-color'],
    '#ffffff',
    layer.id,
    'hillshade-highlight-color',
    warnings,
    true,
  )
  addHillshadeColor(
    out,
    'hillshade-accent-color',
    p['hillshade-accent-color'],
    '#000000',
    layer.id,
    'hillshade-accent-color',
    warnings,
    false,
  )

  // hillshade-method: standard (default) is byte-identical and emits nothing;
  // basic is the GDAL-Lambert model; combined / igor / multidirectional emit
  // the enum but warn that the (INC-3) renderer approximates them via basic.
  const method = unwrapLiteral(p['hillshade-method'])
  if (typeof method === 'string' && method !== 'standard') {
    if (method === 'basic') {
      out.push('hillshade-method-basic')
    } else if (method === 'combined' || method === 'igor' || method === 'multidirectional') {
      out.push(`hillshade-method-${method}`)
      warnings.push(
        `Layer "${layer.id}" — hillshade-method: "${method}" approximated at runtime via the basic model (INC-3 fallback).`,
      )
    } else {
      warnings.push(
        `Layer "${layer.id}" — hillshade-method: "${String(method).slice(0, 40)}" unrecognised; Mapbox spec allows standard | basic | combined | igor | multidirectional. Treated as standard.`,
      )
    }
  }

  // resampling: linear (default) is byte-identical and emits nothing; nearest
  // selects a nearest-filtered DEM height field (mirror raster-resampling-nearest).
  const rs = unwrapLiteral(p['resampling'])
  if (rs === 'nearest') {
    out.push('hillshade-resampling-nearest')
  } else if (rs !== undefined && rs !== null && rs !== 'linear') {
    warnings.push(
      `Layer "${layer.id}" — resampling: ${JSON.stringify(rs)} unrecognised; Mapbox spec allows only "linear" | "nearest". Treated as linear.`,
    )
  }
}

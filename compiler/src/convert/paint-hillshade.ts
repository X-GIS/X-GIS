// Mapbox `hillshade` layer paint → xgis utilities (#777 Phase II). Per-type
// emitter group modelled on paint-raster.ts (`emitRasterPaint` +
// `addRasterScalar`): constant-form emit, spec-default no-op suppression, and
// warn-on-non-constant. Called by the thin dispatcher in paint.ts.
//
// Scope: constant forms. The spec types `hillshade-illumination-direction` /
// `-altitude` as numberArray and `hillshade-shadow-color` / `-highlight-color`
// as colorArray, and allows multiple light sources ONLY under
// `hillshade-method: multidirectional` — there the arrays normalise per
// MapLibre (N = max length, short arrays pad by repeating their last element)
// and sources 2..4 emit as numbered utilities
// (`hillshade-illumination-direction2-…`); >4 sources truncate with a warning
// (the runtime uniform carries 4). Under any other method a >1 array warns and
// uses element 0 (matching MapLibre, whose non-multidirectional shaders read
// only source 0). Non-constant (interpolate / data-driven) forms warn + drop
// (spec default → suppressed).
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

/** Emit a `numberArray`-typed illumination scalar (direction / altitude) for a
 *  NON-multidirectional method: only source 0 is lit (matching MapLibre, whose
 *  standard/basic/combined/igor shaders read u_azimuths[0]), so a >1-length
 *  array warns and uses the first element. Non-constant forms warn + drop. */
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
        `Layer "${layerId}" — paint.${prop}: multiple illumination sources apply only to hillshade-method: multidirectional — using the first of ${v.length}.`,
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

/** Parse a `numberArray` prop into a constant number[]. A bare number wraps to
 *  a 1-array; an empty array or any non-numeric element returns null (the
 *  caller warns + falls back to the spec default). */
function readNumberArray(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return null
  const v = unwrapLiteral(raw)
  const nums = (Array.isArray(v) ? v : [v]).map(unwrapLiteral)
  const out: number[] = []
  for (const n of nums) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    out.push(n)
  }
  return out.length > 0 ? out : null
}

/** Parse a `colorArray` prop into constant hexes. A single colour (string /
 *  rgb-tuple / colour-fn expression head) wraps to a 1-array; any element that
 *  fails colorToXgis returns null (colorToXgis already warned). */
function readColorArray(raw: unknown, warnings: string[]): string[] | null {
  if (raw === undefined || raw === null) return null
  const v = unwrapLiteral(raw)
  let items: unknown[]
  if (Array.isArray(v)) {
    const head = v[0]
    const isSingleColorOrExpr =
      typeof head === 'string' && COLOR_OR_EXPR_HEADS.has(head.toLowerCase())
    items = isSingleColorOrExpr ? [v] : v
  } else {
    items = [v]
  }
  const out: string[] = []
  for (const item of items) {
    const hex = colorToXgis(unwrapLiteral(item), warnings)
    if (hex === null) return null
    out.push(hex)
  }
  return out.length > 0 ? out : null
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
          `Layer "${layerId}" — paint.${prop}: multiple illumination sources apply only to hillshade-method: multidirectional — using the first of ${v.length} colours.`,
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
  // Method first — it decides whether the illumination arrays mean multiple
  // sources (multidirectional) or just source 0 (every other method).
  const method = unwrapLiteral(p['hillshade-method'])
  const isMultidirectional = method === 'multidirectional'

  if (isMultidirectional) {
    // MapLibre normalisation: N = max(array lengths), short arrays pad by
    // repeating their last element. The runtime uniform carries 4 sources —
    // longer arrays truncate with a warning.
    const dirs = readNumberArray(p['hillshade-illumination-direction']) ?? [335]
    const alts = readNumberArray(p['hillshade-illumination-altitude']) ?? [45]
    const shadows = readColorArray(p['hillshade-shadow-color'], warnings) ?? ['#000000']
    const highlights = readColorArray(p['hillshade-highlight-color'], warnings) ?? ['#ffffff']
    let n = Math.max(dirs.length, alts.length, shadows.length, highlights.length)
    if (n > 4) {
      warnings.push(
        `Layer "${layer.id}" — hillshade multidirectional: ${n} illumination sources authored; the runtime supports 4 — extra sources dropped.`,
      )
      n = 4
    }
    const at = <T>(arr: readonly T[], i: number): T => arr[Math.min(i, arr.length - 1)]!
    // Source 1 keeps the spec-default suppression (byte-identical to the
    // single-source emit); sources 2..N are always explicit — the lowerer
    // resolves a missing axis from source 1, so full emission keeps the
    // repeat-last padding exact.
    if (at(dirs, 0) !== 335) out.push(`hillshade-illumination-direction-${at(dirs, 0)}`)
    if (at(alts, 0) !== 45) out.push(`hillshade-illumination-altitude-${at(alts, 0)}`)
    if (at(shadows, 0).toLowerCase() !== '#000000')
      out.push(`hillshade-shadow-color-${at(shadows, 0)}`)
    if (at(highlights, 0).toLowerCase() !== '#ffffff')
      out.push(`hillshade-highlight-color-${at(highlights, 0)}`)
    for (let i = 1; i < n; i++) {
      out.push(`hillshade-illumination-direction${i + 1}-${at(dirs, i)}`)
      out.push(`hillshade-illumination-altitude${i + 1}-${at(alts, i)}`)
      out.push(`hillshade-shadow-color${i + 1}-${at(shadows, i)}`)
      out.push(`hillshade-highlight-color${i + 1}-${at(highlights, i)}`)
    }
  } else {
    // Illumination direction / altitude (numberArray; source 0 only here).
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
  }

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

  // shadow / highlight (colorArray; the multidirectional branch above already
  // emitted them per source) + accent (single color, every method).
  if (!isMultidirectional) {
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
  }
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
  // all five MapLibre v5 methods (basic / combined / igor / multidirectional)
  // are implemented in fs_hillshade.
  if (typeof method === 'string' && method !== 'standard') {
    if (
      method === 'basic' ||
      method === 'combined' ||
      method === 'igor' ||
      method === 'multidirectional'
    ) {
      out.push(`hillshade-method-${method}`)
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

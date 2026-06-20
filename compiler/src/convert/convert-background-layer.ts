// ═══ Background-layer converter for convertMapboxStyle ═══
//
// X-GIS has a top-level `background { fill: <color> }` directive rather
// than a layer with `paint.background-color`. This converter is lifted
// out of mapbox-to-xgis.ts so the orchestrator stays a single page. It
// pushes lines / warnings / coverage in the EXACT same order the inlined
// body did — the converter-warning-coverage + conversion-notes tests pin
// that order.

import type { MapboxLayer } from './types'
import { colorToXgis } from './colors'
import { interpolateZoomCall } from './paint'
import type { StyleCoverage } from './mapbox-to-xgis'

/** Convert the `background` layer (already located by the orchestrator)
 *  into a top-level `background { … }` directive, appending emitted
 *  lines, warnings, and (when present) a coverage record. */
export function convertBackgroundLayer(
  bgLayer: MapboxLayer,
  lines: string[],
  warnings: string[],
  coverage: StyleCoverage | undefined,
): void {
  const before = warnings.length
  // Respect `layout.visibility: 'none'` on background layers per
  // Mapbox spec — without this gate a hidden background emitted a
  // fill anyway and over-painted whatever canvas-clear / underlying
  // colour the host expected to show through. Same v8 literal-wrap
  // unwrap as the visibility gate on other layer types.
  // Loop peel for multi-level wraps mirror of unwrapLiteralScalar
  // (0532bc3). Pre-fix only single-level ['literal', 'none'] was
  // recognised; ['literal', ['literal', 'none']] from preprocessor
  // chains left the layer rendering despite the author's hide.
  let bgVisibility: unknown = bgLayer.layout?.visibility
  while (Array.isArray(bgVisibility) && bgVisibility.length === 2
      && bgVisibility[0] === 'literal') {
    bgVisibility = bgVisibility[1]
  }
  const bgVisibilityNone = bgVisibility === 'none'
  // Mapbox spec: visibility must be 'visible' | 'none'. Warn on
  // typo'd values that silently fell to default 'visible'.
  if (typeof bgVisibility === 'string' && bgVisibility !== 'visible' && bgVisibility !== 'none') {
    warnings.push(`Background layer "${bgLayer.id}" — visibility "${bgVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }
  const color = bgLayer.paint?.['background-color']
  // Probe the constant-colour conversion into a scratch warnings
  // buffer so a zoom-interp `background-color` (which colorToXgis
  // declines with a "Color expression not converted" note) doesn't
  // leak that note when the WS-1 interpolate path below DOES convert
  // it. The scratch warnings are committed to the real list only when
  // we keep the constant result.
  const colorProbeWarnings: string[] = []
  let colorStr = bgVisibilityNone ? null : colorToXgis(color, colorProbeWarnings)
  // WS-1 — zoom-interpolated background-color. When `background-color`
  // is `["interpolate", ["linear"], ["zoom"], …]`, emit the colour as
  // an `interpolate(zoom, …)` fill value so map.ts resolves the RGBA
  // per frame (flat: background-pass clear; sphere: synthetic earth-
  // surface show paintShapes.fill). The constant path keeps emitting a
  // hex via `colorStr`. colorToXgis returns null on the interpolate
  // shape, so this only fires when the constant path already declined.
  const colorInterp = (colorStr === null && !bgVisibilityNone)
    ? interpolateZoomCall(color, warnings, (val, w) => colorToXgis(val, w))
    : null
  // Commit the constant-colour probe diagnostics unless the interpolate
  // path claimed the value (then the "not converted" note is spurious).
  if (colorInterp === null) warnings.push(...colorProbeWarnings)
  // Defensive: coerce non-object bgLayer.paint to {} (mirror of the
  // layers.ts safePropsBag guard). A string paint value previously
  // let bgPaint['background-opacity'] index a char and the warning
  // list leaked garbage property names.
  const rawBgPaint = bgLayer.paint
  const bgPaint = (rawBgPaint !== null && rawBgPaint !== undefined
    && typeof rawBgPaint === 'object' && !Array.isArray(rawBgPaint))
    ? rawBgPaint as Record<string, unknown>
    : {}
  // Background-opacity constant fold (same pattern as
  // circle-stroke-opacity iter 4 partial landing). When both
  // background-color hex AND a constant numeric background-opacity
  // < 1 are authored, fold the opacity into the hex alpha channel.
  // Zoom-interp / data-driven forms fall through to the opacity:
  // interpolate emit below (WS-1).
  {
    let bgOpRaw: unknown = bgPaint['background-opacity']
    while (Array.isArray(bgOpRaw) && bgOpRaw.length === 2 && bgOpRaw[0] === 'literal') bgOpRaw = bgOpRaw[1]
    if (colorStr && typeof bgOpRaw === 'number' && Number.isFinite(bgOpRaw) && bgOpRaw < 0.999) {
      const a = Math.max(0, Math.min(1, bgOpRaw))
      const baseAlpha = colorStr.length === 9
        ? parseInt(colorStr.slice(7, 9), 16) / 255
        : 1
      const ai = Math.round(baseAlpha * a * 255)
      const aHex = ai.toString(16).padStart(2, '0')
      colorStr = colorStr.slice(0, 7) + aHex
    }
  }
  const bgOpacity = bgPaint['background-opacity']
  // WS-1 — zoom-interpolated background-opacity. Emit an `opacity:`
  // style property (0..100, like circle-opacity) that map.ts lexes
  // back into a PropertyShape<number> and multiplies into the clear
  // alpha per frame. Constant numeric opacity already folded into the
  // hex above; only the non-constant interpolate form lands here.
  const bgOpacityIsConstant = (() => {
    let v: unknown = bgOpacity
    while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
    return typeof v === 'number' && Number.isFinite(v)
  })()
  const opacityInterp = !bgOpacityIsConstant
    ? interpolateZoomCall(bgOpacity, warnings, (val) =>
        typeof val === 'number' && Number.isFinite(val)
          ? String(Math.round(Math.max(0, Math.min(1, val)) * 100))
          : null)
    : null
  // Emit the background block from the resolved fill (constant hex OR
  // zoom-interp) + the optional zoom-interp opacity. The xgis
  // `background { … }` directive parses both `fill:` and `opacity:`
  // style properties (parser.isStylePropertyStart).
  const fillStr = colorStr ?? colorInterp
  if (fillStr) {
    const body = opacityInterp
      ? `fill: ${fillStr} opacity: ${opacityInterp}`
      : `fill: ${fillStr}`
    lines.push(`background { ${body} }`)
    lines.push('')
  }
  // Surface dropped background paint props. background-pattern is
  // the bitmap-atlas equivalent (Batch 2 follow-up). Constant
  // background-opacity folds into the hex; zoom-interp opacity emits
  // an `opacity:` property above — neither surfaces here. A
  // data-driven (non-zoom) opacity that interpolateZoomCall declined
  // (opacityInterp === null) is still a real gap.
  const bgIgnored: string[] = []
  if (bgOpacity !== undefined && bgOpacity !== null
      && !bgOpacityIsConstant && opacityInterp === null) {
    bgIgnored.push('background-opacity (non-constant)')
  }
  const bgPattern = bgPaint['background-pattern']
  if (bgPattern !== undefined && bgPattern !== null) bgIgnored.push('background-pattern (Batch 2)')
  if (bgIgnored.length > 0) {
    warnings.push(`Background layer "${bgLayer.id}" — ignored properties: ${bgIgnored.join(', ')}`)
  }
  if (coverage) {
    const reasons = warnings.slice(before)
    coverage.layers.push({
      layerId: bgLayer.id,
      type: 'background',
      action: fillStr ? (reasons.length > 0 ? 'lossy' : 'converted') : 'skipped',
      reasons,
    })
  }
}

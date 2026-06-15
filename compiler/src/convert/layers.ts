import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis } from './expressions'
import { paintToUtilities } from './paint'
import type { SymbolLayerOverrides } from './layers-types'
import { convertCircleLayer } from './layers-circle'
import {
  convertTextPaintProperties,
  convertTextLayoutProperties,
  convertIconProperties,
  convertGapWarnings,
} from './layers-symbol'
import {
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
  textFieldToXgisExpr,
  parseSymbolPlacementStep,
} from './layers-helpers'
// Re-export the one public helper so importers of './layers' keep their
// surface (font-name-parse + font-weight-end-to-end tests import it here).
export { parseMapboxFontName } from './layers-helpers'

// Layer types whose engine support is on the roadmap but not yet
// landed. Each type gets a more informative SKIPPED comment that
// names the engine work it's waiting on, so users reading the
// converter output know whether the gap is "won't ever support" or
// "coming in batch N".
//
// `symbol` is handled separately below (Batch 1b) — text-field
// emits a `label-[<expr>]` utility so the IR carries the text
// intent through compilation. Rendering arrives in Batch 1c.
const SKIP_REASONS: Record<string, string> = {
  heatmap: 'heatmap layer — Batch 3 (accumulation MRT + Gaussian blur)',
  hillshade: 'hillshade layer — Batch 4 (raster-dem + lighting shader)',
  sky: 'sky layer — gradient/atmospheric sky rendering not yet wired (would need a dome quad + per-fragment hue interpolation)',
}

function convertSymbolLayer(
  layer: MapboxLayer,
  warnings: string[],
  overrides?: SymbolLayerOverrides,
): string {
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const paint = safePropsBag((layer as { paint?: unknown }).paint)
  const textField = layout['text-field']
  const iconImage = unwrapLiteralScalar(layout['icon-image'])
  // Mapbox spec: text-field === null means "no text" (same as
  // undefined). Pre-fix only undefined fell to the icon-only path;
  // an explicit `text-field: null` (uncommon but spec-valid)
  // dropped the layer entirely even when icon-image was set.
  // Multi-wrap null detection — `["literal", null]` / deeper means
  // "no text" per Mapbox spec (null falls back to property default,
  // which for text-field is no rendering). Without this peel hasText
  // stayed true (the wrapper is non-null), iconOnly stayed false, and
  // the layer emitted `label-[null]` instead of going through the
  // icon-only branch.
  const hasText = !isOmittedValue(textField)
  const iconOnly = !hasText && typeof iconImage === 'string'

  if (!hasText && !iconOnly) {
    // No text-field AND no icon-image — nothing renderable.
    warnings.push(`Symbol layer "${layer.id}" — neither text-field nor icon-image; dropping.`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — no text-field or icon-image.`
  }

  // Icon-only symbols emit a label with empty text — runtime renders
  // just the sprite. Both-text-and-icon layers proceed via the
  // existing text path with the icon utilities layered on top.
  const labelExpr = iconOnly
    ? '""'
    : textFieldToXgisExpr(textField, warnings)
  if (labelExpr === null) {
    warnings.push(`Symbol layer "${layer.id}" — text-field "${JSON.stringify(textField).slice(0, 60)}" not convertible.`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — text-field expression not convertible.`
  }

  const layerId = overrides?.idSuffix
    ? `${sanitizeId(layer.id)}_${overrides.idSuffix}`
    : sanitizeId(layer.id)
  const lines: string[] = [`layer ${layerId} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  const effectiveMin = overrides?.minzoom !== undefined ? overrides.minzoom : layer.minzoom
  const effectiveMax = overrides?.maxzoom !== undefined ? overrides.maxzoom : layer.maxzoom
  if (typeof effectiveMin === 'number' && Number.isFinite(effectiveMin)) lines.push(`  minzoom: ${effectiveMin}`)
  if (typeof effectiveMax === 'number' && Number.isFinite(effectiveMax)) lines.push(`  maxzoom: ${effectiveMax}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }
  // `layout.visibility: 'none'` applies to every Mapbox layer type per
  // spec — not just the generic convertLayer path. Without this gate
  // a hidden symbol layer (label / icon) rendered anyway because the
  // converter never emitted `visible: false`. Mirror the unwrap so v8
  // strict `["literal", "none"]` works the same as bare "none".
  const symbolVisibility = unwrapLiteralScalar(layout['visibility'])
  if (symbolVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof symbolVisibility === 'string' && symbolVisibility !== 'visible') {
    // Mapbox spec: visibility must be 'visible' | 'none'. Anything
    // else was silently treated as 'visible' (default), so a typo
    // like 'hidden' silently left the layer visible.
    warnings.push(`Symbol layer "${layer.id}" — visibility "${symbolVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  const utils: string[] = [`label-[${labelExpr}]`]

  convertTextPaintProperties(layer, layout, paint, utils, warnings)

  convertTextLayoutProperties(layer, layout, paint, overrides, utils, warnings)

  convertIconProperties(layer, layout, paint, iconImage, utils, warnings)
  convertGapWarnings(layer, layout, paint, warnings)

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}

/** Mapbox `layers[i]` entry → xgis `layer <id> { … }` block, or
 *  null when the layer is the top-level `background` (handled
 *  specially by `convertMapboxStyle`).
 *
 *  Skipped layer types emit a `// SKIPPED` comment that NAMES the
 *  roadmap batch they're waiting on — so users reading the output
 *  know whether the gap is permanent or coming. */
export function convertLayer(layer: MapboxLayer, warnings: string[]): string | null {
  if (layer.type === 'symbol') {
    // `symbol-placement: ["step", ["zoom"], …]` (OFM Bright highway
    // shields) splits into one xgis layer per zoom-step segment so
    // each segment can carry its own minzoom/maxzoom + resolved
    // placement utility. Literal-string placement falls through to
    // the single-layer path below.
    const segments = parseSymbolPlacementStep(layer)
    if (segments && segments.length > 1) {
      const blocks: string[] = []
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!
        // Intersect the segment's range with the layer's declared
        // minzoom/maxzoom so a layer that's already gated outside
        // the step's full domain stays gated.
        const minzoom = seg.minzoom !== undefined
          ? (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom) ? Math.max(layer.minzoom, seg.minzoom) : seg.minzoom)
          : layer.minzoom
        const maxzoom = seg.maxzoom !== undefined
          ? (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom) ? Math.min(layer.maxzoom, seg.maxzoom) : seg.maxzoom)
          : layer.maxzoom
        blocks.push(convertSymbolLayer(layer, warnings, {
          idSuffix: String(i),
          placement: seg.placement,
          minzoom,
          maxzoom,
        }))
      }
      return blocks.join('\n\n')
    }
    return convertSymbolLayer(layer, warnings)
  }
  if (layer.type === 'circle') {
    return convertCircleLayer(layer, warnings)
  }
  const skipReason = SKIP_REASONS[layer.type]
  if (skipReason !== undefined) {
    warnings.push(`Layer "${layer.id}" type="${layer.type}" — ${skipReason}.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — ${skipReason}.`
  }
  // Distinct failure modes for layer.type — mirror of the source-type
  // validation. Pre-fix missing / non-string layer.type fell through
  // to the main body, paintToUtilities returned [] (no `type === …`
  // matched), the emitted block had no paint utilities, dead-layer-
  // elim killed it silently. The user saw "my layer doesn't render"
  // with no diagnostic.
  const knownLayerTypes = new Set([
    'fill', 'line', 'fill-extrusion', 'raster', 'symbol', 'circle',
    'background', 'heatmap', 'hillshade',
  ])
  if (layer.type === undefined || layer.type === null) {
    warnings.push(`Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" is missing the required type field; emitted SKIPPED placeholder.`)
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — missing required type field.`
  }
  if (typeof layer.type !== 'string') {
    warnings.push(`Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" type field must be a string (got ${typeof layer.type}); emitted SKIPPED placeholder.`)
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — non-string type field.`
  }
  if (!knownLayerTypes.has(layer.type)) {
    warnings.push(`Layer "${layer.id}" has unknown type "${layer.type}"; emitted SKIPPED placeholder. Mapbox spec layer types: fill, line, fill-extrusion, raster, symbol, circle, background, heatmap, hillshade.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — unknown layer type.`
  }

  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom)) lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom)) lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }

  // Mapbox layout properties → xgis equivalents.
  //
  // `visibility: 'none'` is a CSS-style block property (the parser
  // accepts unhyphenated identifiers as property names — `visible`
  // qualifies; `stroke-linecap` does not, hence the utility route
  // for cap/join). Engine support: `compiler/src/ir/lower.ts:903`
  // for `visible:` block prop, lines 402-417 for cap/join utilities.
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const generalVisibility = unwrapLiteralScalar(layout['visibility'])
  if (generalVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof generalVisibility === 'string' && generalVisibility !== 'visible') {
    warnings.push(`Layer "${layer.id}" — visibility "${generalVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  // Cap / join / miter-limit are emitted as UTILITIES (after the `|`)
  // since the xgis parser doesn't accept hyphenated names in the
  // CSS-style property position. Engine handles them via the utility
  // resolver (lower.ts:402-422).
  const layoutUtils: string[] = []
  if (layer.type === 'line') {
    const cap = unwrapLiteralScalar(layout['line-cap'])
    if (cap === 'butt') layoutUtils.push('stroke-butt-cap')
    else if (cap === 'round') layoutUtils.push('stroke-round-cap')
    else if (cap === 'square') layoutUtils.push('stroke-square-cap')
    else if (typeof cap === 'string') {
      // Mapbox spec: line-cap must be 'butt' | 'round' | 'square'.
      // Only flag STRING values not in the enum — expression-shaped
      // (zoom-step) values pass through to downstream handling.
      warnings.push(`Layer "${layer.id}" — line-cap "${cap.slice(0, 40)}" is not a valid enum; expected 'butt' | 'round' | 'square'.`)
    }
    const join = unwrapLiteralScalar(layout['line-join'])
    if (join === 'miter') layoutUtils.push('stroke-miter-join')
    else if (join === 'round') layoutUtils.push('stroke-round-join')
    else if (join === 'bevel') layoutUtils.push('stroke-bevel-join')
    else if (typeof join === 'string') {
      warnings.push(`Layer "${layer.id}" — line-join "${join.slice(0, 40)}" is not a valid enum; expected 'miter' | 'round' | 'bevel'.`)
    }
    const miter = unwrapLiteralScalar(layout['line-miter-limit'])
    if (typeof miter === 'number' && Number.isFinite(miter)) {
      if (miter < 0) {
        warnings.push(`Layer "${layer.id}" — line-miter-limit ${miter} is negative; Mapbox spec default is 2 and values < 1 collapse to bevel joins. Negative emits a malformed utility — clamped to 0.`)
      }
      layoutUtils.push(`stroke-miterlimit-${Math.max(0, miter)}`)
    }
  }

  const utils = [...layoutUtils, ...paintToUtilities(layer, warnings)]
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}

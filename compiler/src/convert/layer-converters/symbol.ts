// ═══ Mapbox symbol layer → xgis conversion ═══
// convertSymbolLayer + the symbol-placement-step dispatch relocated
// verbatim from layers.ts (A4). Zero logic change — same warnings,
// same emit, same per-step expansion order. Registers `symbol`.

import type { MapboxLayer } from '../types'
import { sanitizeId } from '../utils'
import type { SymbolLayerOverrides } from '../layers-types'
import {
  convertTextPaintProperties,
  convertTextLayoutProperties,
  convertIconProperties,
  convertGapWarnings,
} from '../layers-symbol'
import {
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
  textFieldToXgisExpr,
  parseSymbolPlacementStep,
  filterLineOrFailClosed,
} from '../layers-helpers'
import { registerLayerConverter } from './types'

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
  // Authored-but-unconvertible filter fails CLOSED (filter: false →
  // match nothing), not open — see filterLineOrFailClosed.
  const symbolFilterLine = filterLineOrFailClosed(layer.filter, warnings)
  if (symbolFilterLine !== null) lines.push(symbolFilterLine)
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

/** Symbol layer dispatch: `symbol-placement: ["step", ["zoom"], …]`
 *  (OFM Bright highway shields) splits into one xgis layer per
 *  zoom-step segment so each segment can carry its own minzoom/maxzoom
 *  + resolved placement utility. Literal-string placement falls through
 *  to the single-layer path. */
function convertSymbolLayerDispatch(layer: MapboxLayer, warnings: string[]): string {
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

registerLayerConverter('symbol', convertSymbolLayerDispatch)

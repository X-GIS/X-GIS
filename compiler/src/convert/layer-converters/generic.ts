// ═══ Generic Mapbox layer → xgis block converter ═══
// Shared emit body for the layer types whose conversion is the plain
// `layer <id> { source/sourceLayer/zoom/filter/visibility | <utils> }`
// shape: fill, fill-extrusion, raster. The `line` type reuses this body
// but prepends its own cap/join/miter layout utilities (see ./line.ts),
// which is why the body accepts a `layoutUtils` seed.
//
// Relocated verbatim from convertLayer's generic tail (zero logic
// change); registers fill / fill-extrusion / raster.

import type { MapboxLayer } from '../types'
import { sanitizeId } from '../utils'
import { paintToUtilities } from '../paint'
import { unwrapLiteralScalar, safePropsBag, filterLineOrFailClosed } from '../layers-helpers'
import { registerLayerConverter } from './types'

/** Emit the generic `layer { … }` block. `layoutUtils` seeds the
 *  utility list before the paint utilities — the `line` converter
 *  passes its cap/join/miter utilities here; all other generic types
 *  pass nothing. Byte-identical to convertLayer's former generic body. */
export function convertGenericLayer(
  layer: MapboxLayer,
  warnings: string[],
  layoutUtils: string[] = [],
): string {
  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom)) lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom)) lines.push(`  maxzoom: ${layer.maxzoom}`)
  // Authored-but-unconvertible filter fails CLOSED (filter: false →
  // match nothing), not open — see filterLineOrFailClosed.
  const genericFilterLine = filterLineOrFailClosed(layer.filter, warnings)
  if (genericFilterLine !== null) lines.push(genericFilterLine)

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

  const utils = [...layoutUtils, ...paintToUtilities(layer, warnings)]
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}

registerLayerConverter('fill', (layer, warnings) => convertGenericLayer(layer, warnings))
registerLayerConverter('fill-extrusion', (layer, warnings) => convertGenericLayer(layer, warnings))
registerLayerConverter('raster', (layer, warnings) => convertGenericLayer(layer, warnings))
// `background` reached convertLayer's generic body in the former code
// too (it is in knownLayerTypes), though convertMapboxStyle handles
// background before ever calling convertLayer — so in practice this
// branch is unreached. Registered here purely to keep convertLayer's
// in-isolation behaviour byte-identical to the pre-refactor function.
registerLayerConverter('background', (layer, warnings) => convertGenericLayer(layer, warnings))

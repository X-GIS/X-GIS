// ═══ Mapbox line layer → xgis conversion ═══
// The `line` layer reuses the generic block body but owns the
// cap / join / miter-limit LAYOUT utilities — relocated here from
// convertLayer's inline `if (layer.type === 'line')` block (A4). These
// are emitted as UTILITIES (after the `|`) because the xgis parser
// doesn't accept hyphenated names in the CSS-style property position;
// the engine resolves them via the utility resolver (lower.ts:402-422).
//
// Byte-identical to the former inline block: same warnings, same
// utility strings, same order (cap → join → miter), and the utilities
// are seeded BEFORE the paint utilities exactly as before.

import type { MapboxLayer } from '../types'
import { unwrapLiteralScalar, safePropsBag } from '../layers-helpers'
import { convertGenericLayer } from './generic'
import { registerLayerConverter } from './types'

export function convertLineLayer(layer: MapboxLayer, warnings: string[]): string {
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const layoutUtils: string[] = []
  const cap = unwrapLiteralScalar(layout['line-cap'])
  if (cap === 'butt') layoutUtils.push('stroke-butt-cap')
  else if (cap === 'round') layoutUtils.push('stroke-round-cap')
  else if (cap === 'square') layoutUtils.push('stroke-square-cap')
  else if (typeof cap === 'string') {
    // Mapbox spec: line-cap must be 'butt' | 'round' | 'square'.
    // Only flag STRING values not in the enum — expression-shaped
    // (zoom-step) values pass through to downstream handling.
    warnings.push(
      `Layer "${layer.id}" — line-cap "${cap.slice(0, 40)}" is not a valid enum; expected 'butt' | 'round' | 'square'.`,
    )
  }
  const join = unwrapLiteralScalar(layout['line-join'])
  if (join === 'miter') layoutUtils.push('stroke-miter-join')
  else if (join === 'round') layoutUtils.push('stroke-round-join')
  else if (join === 'bevel') layoutUtils.push('stroke-bevel-join')
  else if (typeof join === 'string') {
    warnings.push(
      `Layer "${layer.id}" — line-join "${join.slice(0, 40)}" is not a valid enum; expected 'miter' | 'round' | 'bevel'.`,
    )
  }
  const miter = unwrapLiteralScalar(layout['line-miter-limit'])
  if (typeof miter === 'number' && Number.isFinite(miter)) {
    if (miter < 0) {
      warnings.push(
        `Layer "${layer.id}" — line-miter-limit ${miter} is negative; Mapbox spec default is 2 and values < 1 collapse to bevel joins. Negative emits a malformed utility — clamped to 0.`,
      )
    }
    layoutUtils.push(`stroke-miterlimit-${Math.max(0, miter)}`)
  }
  // line-round-limit (Mapbox default 1.05) — threshold that controls when
  // round joins fold. Threaded to the line layer uniform; the shader scales
  // its round-join acute-fold threshold by `round-limit / 1.05`, so the
  // default reproduces today's geometry byte-for-byte. Emit only when
  // authored AND > 0 (a non-positive value would zero the uniform slot,
  // which the shader reads as "use the historical constant"). Constant
  // literal only — expression forms pass through unhandled.
  const roundLimit = unwrapLiteralScalar(layout['line-round-limit'])
  if (typeof roundLimit === 'number' && Number.isFinite(roundLimit) && roundLimit > 0) {
    layoutUtils.push(`stroke-roundlimit-${roundLimit}`)
  }

  return convertGenericLayer(layer, warnings, layoutUtils)
}

registerLayerConverter('line', convertLineLayer)

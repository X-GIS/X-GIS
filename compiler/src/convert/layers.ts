import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis } from './expressions'
import { paintToUtilities } from './paint'

const SKIPPED_TYPES = new Set(['symbol', 'circle', 'heatmap', 'hillshade'])

/** Mapbox `layers[i]` entry → xgis `layer <id> { … }` block, or
 *  null when the layer is the top-level `background` (handled
 *  specially by `convertMapboxStyle`).
 *
 *  Layers of `type: symbol / circle / heatmap / hillshade` aren't
 *  rendered by the current X-GIS engine — emit a `// SKIPPED`
 *  comment so the user sees what got dropped instead of silently
 *  losing it. */
export function convertLayer(layer: MapboxLayer, warnings: string[]): string | null {
  if (SKIPPED_TYPES.has(layer.type)) {
    warnings.push(`Layer "${layer.id}" type="${layer.type}" not yet supported by converter — skipped.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — unsupported by current X-GIS engine.`
  }

  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: "${layer['source-layer']}"`)
  if (typeof layer.minzoom === 'number') lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number') lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }
  const utils = paintToUtilities(layer, warnings)
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}

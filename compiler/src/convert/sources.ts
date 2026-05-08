import type { MapboxSource } from './types'
import { sanitizeId } from './utils'

/** Mapbox `sources[id]` entry → xgis `source <id> { … }` block.
 *
 *  Routing rules:
 *   - `type: vector` with a `.pmtiles` URL    → `type: pmtiles`
 *   - `type: vector` with anything else       → `type: tilejson`
 *     (the runtime fetches the manifest then drives the same
 *      attachPMTilesSource backend)
 *   - `type: raster` with `tiles[]` or `url`  → `type: raster`
 *   - `type: geojson` with inline `data`      → TODO + warn
 *     (xgis has no inline-data route at the moment)
 *   - anything else                           → TODO + warn */
export function convertSource(id: string, src: MapboxSource, warnings: string[]): string {
  const lines: string[] = [`source ${sanitizeId(id)} {`]
  if (src.type === 'vector') {
    const url = src.url ?? src.tiles?.[0]
    if (url && /\.pmtiles(\?|$)/.test(url)) {
      lines.push('  type: pmtiles')
      lines.push(`  url: "${url}"`)
    } else if (url) {
      lines.push('  type: tilejson')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: vector source without url/tiles — fill in PMTiles archive URL')
      warnings.push(`Source "${id}" has neither url nor tiles[]; emitted placeholder.`)
    }
  } else if (src.type === 'raster') {
    const url = src.tiles?.[0] ?? src.url
    if (url) {
      lines.push('  type: raster')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: raster source missing url/tiles')
      warnings.push(`Raster source "${id}" has no URL.`)
    }
  } else if (src.type === 'geojson') {
    const url = (src as { data?: string | unknown }).data
    if (typeof url === 'string') {
      lines.push('  type: geojson')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: GeoJSON inline data not yet supported by converter')
      warnings.push(`GeoJSON source "${id}" has inline data; converter only handles external URLs.`)
    }
  } else {
    lines.push(`  // TODO: unsupported source type "${src.type}"`)
    warnings.push(`Source "${id}" has unsupported type "${src.type}".`)
  }
  lines.push('}')
  return lines.join('\n')
}

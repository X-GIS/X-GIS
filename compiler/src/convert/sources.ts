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
 *   - `type: geojson` with URL `data`         → `type: geojson` with url
 *   - `type: geojson` with inline `data`      → `type: geojson` no url
 *     (xgis runtime seeds an empty FeatureCollection; the host
 *      injects the data via `setSourceData(id, fc)` after `run()`)
 *   - `type: raster-dem`                      → emit + warn (Batch 4)
 *   - `type: image` / `video`                 → skip + warn */
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
  } else if (src.type === 'raster-dem') {
    // Source registered but rendering not yet implemented (Batch 4).
    // Emit type so the runtime's source registry has the entry — a
    // future hillshade / 3D-terrain layer will pick it up.
    const url = src.tiles?.[0] ?? src.url
    if (url) {
      lines.push('  type: raster-dem')
      lines.push(`  url: "${url}"`)
      lines.push('  // NOTE: raster-dem rendering (hillshade / 3D terrain) — Batch 4 of the Mapbox compatibility roadmap.')
      warnings.push(`Source "${id}" type="raster-dem" registered but rendering not yet supported (Batch 4 — hillshade + 3D terrain).`)
    } else {
      lines.push('  // TODO: raster-dem source missing url/tiles')
      warnings.push(`raster-dem source "${id}" has no URL.`)
    }
  } else if (src.type === 'geojson') {
    const data = (src as { data?: string | unknown }).data
    if (typeof data === 'string') {
      // External URL — runtime fetches and decodes lazily.
      lines.push('  type: geojson')
      lines.push(`  url: "${data}"`)
    } else if (data && typeof data === 'object') {
      // Inline FeatureCollection / Feature / Geometry. xgis runtime
      // accepts a no-url geojson source as an "inline" stub; the host
      // application is responsible for calling `map.setSourceData(id,
      // featureCollection)` once after `map.run(source)` to populate
      // it. Comment block carries the JSON so readers see what would
      // have been pushed.
      lines.push('  type: geojson')
      lines.push('  // inline data — call map.setSourceData("' + sanitizeId(id) + '", <FeatureCollection>) after run()')
      // Emit the data as a JSON literal in a comment so the reader
      // can copy it. Truncate at 2KB to keep the converter output
      // small for very large inline datasets.
      const json = JSON.stringify(data)
      if (json.length > 2000) {
        lines.push(`  // data: ${json.slice(0, 2000)}...  (truncated, ${json.length} bytes total)`)
      } else {
        lines.push(`  // data: ${json}`)
      }
      warnings.push(`GeoJSON source "${id}" has inline data — emitted as no-URL stub; call map.setSourceData() after run().`)
    } else {
      lines.push('  // TODO: GeoJSON source missing data field')
      warnings.push(`GeoJSON source "${id}" has no data field.`)
    }
  } else if (src.type === 'image' || src.type === 'video') {
    lines.push(`  // SKIPPED: ${src.type} source not yet supported by X-GIS engine`)
    warnings.push(`Source "${id}" type="${src.type}" — image/video sources not yet supported (no roadmap entry; file an issue if needed).`)
  } else {
    lines.push(`  // TODO: unsupported source type "${src.type}"`)
    warnings.push(`Source "${id}" has unsupported type "${src.type}".`)
  }
  lines.push('}')
  return lines.join('\n')
}

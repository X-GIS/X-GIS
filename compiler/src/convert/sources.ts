import type { MapboxSource } from './types'
import { sanitizeId } from './utils'

export interface ConvertSourceOptions {
  /** When provided, inline GeoJSON `source.data` objects are stashed
   *  into this map keyed by `sanitizeId(sourceId)`. The importer (the
   *  runtime resolver) then auto-pushes each entry via setSourceData
   *  after run() — host no longer needs to do it manually. Without a
   *  collector the converter falls back to the original "no-URL stub
   *  + warning" behaviour for backward compatibility. */
  inlineGeoJSON?: Map<string, unknown>
}

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
 *     (with `options.inlineGeoJSON` collector: data is captured for
 *     auto-push; without: runtime seeds an empty FC and the host must
 *     call `setSourceData(id, fc)` after `run()`)
 *   - `type: raster-dem`                      → emit + warn (Batch 4)
 *   - `type: image` / `video`                 → skip + warn */
export function convertSource(
  id: string,
  src: MapboxSource,
  warnings: string[],
  options?: ConvertSourceOptions,
): string {
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
      lines.push('  type: geojson')
      const safeId = sanitizeId(id)
      if (options?.inlineGeoJSON) {
        // Mapbox/MapLibre `source.data` permits FeatureCollection,
        // Feature, OR a bare Geometry. The runtime's rebuildLayers
        // path indexes `.features` directly — feeding a single Feature
        // (e.g. the `crimea` source in the MapLibre demo style) or a
        // raw Geometry trips `.features[0]` access on undefined.
        // Normalise here so the inline-push path always seeds a
        // FeatureCollection regardless of which valid shape arrived.
        options.inlineGeoJSON.set(safeId, normaliseInlineGeoJSON(data))
        lines.push('  // inline data captured by importer (auto-pushed via setSourceData)')
      } else {
        lines.push('  // inline data — call map.setSourceData("' + safeId + '", <FeatureCollection>) after run()')
        const json = JSON.stringify(data)
        if (json.length > 2000) {
          lines.push(`  // data: ${json.slice(0, 2000)}...  (truncated, ${json.length} bytes total)`)
        } else {
          lines.push(`  // data: ${json}`)
        }
        warnings.push(`GeoJSON source "${id}" has inline data — emitted as no-URL stub; call map.setSourceData() after run().`)
      }
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

/** Wrap a Mapbox-style `source.data` value into a FeatureCollection.
 *  Mapbox / MapLibre allow:
 *   - FeatureCollection  → pass through
 *   - Feature            → wrap as { type: FC, features: [feat] }
 *   - Geometry           → wrap as { type: FC, features: [{ type: Feature, geometry }] }
 *  Anything else returns a single-feature collection with an
 *  empty-properties feature pointing at the raw value — defensive
 *  fallback so the runtime's `.features` access never undefines. */
function normaliseInlineGeoJSON(data: unknown): unknown {
  if (data === null || typeof data !== 'object') {
    return { type: 'FeatureCollection', features: [] }
  }
  const obj = data as { type?: string; features?: unknown[]; geometry?: unknown; properties?: unknown }
  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return obj
  if (obj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [obj] }
  }
  // Bare Geometry (`Point`, `LineString`, `Polygon`, `MultiPoint`, …)
  // — wrap in a Feature, then a FeatureCollection.
  if (typeof obj.type === 'string') {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: obj, properties: {} }],
    }
  }
  return { type: 'FeatureCollection', features: [] }
}

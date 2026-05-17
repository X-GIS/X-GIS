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
  // Mapbox source spec permits `tiles: [url0, url1, ...]` — the array
  // describes EQUIVALENT endpoints (typically subdomain-rotated mirrors
  // like `a.tile.example.com`, `b.tile.example.com`). MapLibre rotates
  // requests across them to spread load and bypass per-host concurrency
  // caps. The X-GIS runtime currently consumes a single URL per source,
  // so we pick `tiles[0]` here and warn so style authors aren't
  // surprised by the missing parallelism.
  if (Array.isArray(src.tiles) && src.tiles.length > 1) {
    warnings.push(`Source "${id}" declares ${src.tiles.length} tile endpoint mirrors (subdomain rotation); the runtime uses only the first — others are ignored. Affects fetch parallelism, not correctness.`)
  }

  // Mapbox `scheme: "tms"` flips the Y axis (origin bottom-left vs the
  // XYZ default top-left). X-GIS's tile selector assumes XYZ throughout
  // — if a style declares TMS, every tile renders mirrored on Y. Stadia,
  // Stamen, and older OSM mirrors ship TMS endpoints; modern Mapbox /
  // MapLibre / OFM all use the default XYZ. Surface the mismatch so the
  // user doesn't silently get an upside-down map.
  if (src.scheme === 'tms') {
    warnings.push(`Source "${id}" declares scheme: "tms" but the X-GIS tile selector assumes XYZ (top-left origin) — tiles will render Y-flipped. Convert the URL template to XYZ form, or wait for native scheme support.`)
  }

  // Mapbox source-level `minzoom` / `maxzoom` constrain which tile
  // zooms the source actually serves. X-GIS's tile selector uses
  // LAYER-level minzoom/maxzoom (per-show culling) but doesn't yet
  // consume the SOURCE-level bounds, so a raster source with
  // `maxzoom: 6` (typical for low-res shaded relief like ne2_shaded)
  // gets tile requests at z=7+ from the renderer, all of which return
  // 404 and fall back to parent ancestors. Wasteful, not incorrect —
  // surface so the style author knows fetch volume isn't optimal.
  if (typeof src.minzoom === 'number' || typeof src.maxzoom === 'number') {
    warnings.push(`Source "${id}" declares minzoom/maxzoom (${src.minzoom ?? '-'}…${src.maxzoom ?? '-'}); the runtime tile selector doesn't yet honour source-level zoom bounds, so out-of-range tiles will be requested and 404. Use layer-level minzoom/maxzoom to limit fetch volume.`)
  }

  // Mapbox source-level `bounds: [west, south, east, north]` is the
  // spatial-extent gate — tiles outside the box should never be
  // requested. X-GIS's tile selector is global-only today, so a
  // regional source (e.g. a city basemap with bounds covering one
  // metro area) gets requests for ocean tiles too. Same wasteful-but-
  // correct pattern as the zoom-bound gap above.
  if (Array.isArray(src.bounds) && src.bounds.length === 4) {
    warnings.push(`Source "${id}" declares bounds [${src.bounds.join(', ')}]; the runtime tile selector doesn't yet clip requests to the spatial extent, so tiles outside the box will be requested and 404. Filter coverage at the host (geojson clip / pre-cropped PMTiles archive) until native bounds support lands.`)
  }

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

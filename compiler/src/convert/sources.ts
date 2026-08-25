import type { MapboxSource } from './types'
import { sanitizeId } from './utils'
import { checkSourceBounds } from '../ir/source-bounds'
import { isTileScheme, schemeRejectReason } from '../ir/source-scheme'
import { convertSourceCluster } from './sources-cluster'

export interface ConvertSourceOptions {
  /** When provided, inline GeoJSON `source.data` objects are stashed
   *  into this map keyed by `sanitizeId(sourceId)`. The importer (the
   *  runtime resolver) then auto-pushes each entry via setSourceData
   *  after run() — host no longer needs to do it manually. Without a
   *  collector the converter falls back to the original "no-URL stub
   *  + warning" behaviour for backward compatibility. */
  inlineGeoJSON?: Map<string, unknown>
}

// #1977 — a `mapbox://` scheme URL requires the Mapbox API + an access
// token. The X-GIS runtime has no Mapbox auth logic anywhere (source-
// manager.ts only prepends baseUrl to a non-http(s)/non-'/' URL), so a
// mapbox:// source can only 404 at fetch time — and every real Mapbox
// v11+ terrain style ships a `raster-dem` source in exactly this shape.
// Warn but keep emitting the URL as-is (warn-only — every call site below
// keeps its existing emission unchanged). Shared by every branch that
// reads a source url (vector / raster / raster-dem / the explicit
// "type": "tilejson" arm); the pmtiles:// scheme handling above
// (stripPmtilesScheme) is a different, already-handled scheme.
function warnMapboxSchemeUrl(id: string, url: unknown, warnings: string[]): void {
  if (typeof url === 'string' && /^mapbox:\/\//i.test(url)) {
    warnings.push(
      `Source "${id}" url "${url.slice(0, 80)}" requires the Mapbox API and an access token — not supported; host a MapLibre-compatible style or point at an https TileJSON.`,
    )
  }
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
  // Malformed style: a source value that's null or not an object.
  // Mapbox spec requires an object, but partial / hand-edited JSON in
  // the wild can have null source bodies. Pre-fix the function crashed
  // at `src.tiles` / `src.scheme` etc. and the WHOLE style failed to
  // convert — even unrelated layers dropped. Emit a placeholder + warn
  // so the rest of the style still converts.
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    warnings.push(`Source "${id}" has invalid (non-object) body; emitted placeholder.`)
    return `source ${sanitizeId(id)} {\n  // TODO: invalid source body\n}`
  }
  const lines: string[] = [`source ${sanitizeId(id)} {`]
  // Mapbox source spec permits `tiles: [url0, url1, ...]` — the array
  // describes EQUIVALENT endpoints (typically subdomain-rotated mirrors
  // like `a.tile.example.com`, `b.tile.example.com`). MapLibre rotates
  // requests across them to spread load and bypass per-host concurrency
  // caps. The X-GIS runtime currently consumes a single URL per source,
  // so we pick `tiles[0]` here and warn so style authors aren't
  // surprised by the missing parallelism.
  if (Array.isArray(src.tiles) && src.tiles.length > 1) {
    warnings.push(
      `Source "${id}" declares ${src.tiles.length} tile endpoint mirrors (subdomain rotation); the runtime uses only the first — others are ignored. Affects fetch parallelism, not correctness.`,
    )
  }
  // Defensive: spec requires src.tiles to be an array of URL strings.
  // A malformed style that passes `tiles: "https://…"` as a bare
  // string (common cut-and-paste mistake from people thinking of
  // `url:`) would otherwise let `src.tiles?.[0]` return the first
  // CHAR of the URL ("h"), producing a broken xgis source. Drop the
  // mis-typed value and warn; downstream `src.url` fallback still
  // works.
  if (src.tiles !== undefined && !Array.isArray(src.tiles)) {
    warnings.push(
      `Source "${id}" tiles must be an array of URL strings — ignoring non-array value (was ${typeof src.tiles}).`,
    )
    ;(src as { tiles?: unknown }).tiles = undefined
  }
  // Defensive: spec requires src.url to be a string. A non-string url
  // (object / array) would otherwise serialise via JSON.stringify into
  // the emitted xgis as `url: "{\"foo\":1}"` — the runtime would
  // fetch that literal string and 404 on every request. Drop the
  // mis-typed value so downstream falls back to tiles[0] (or the
  // placeholder).
  if (src.url !== undefined && src.url !== null && typeof src.url !== 'string') {
    warnings.push(
      `Source "${id}" url must be a string — ignoring non-string value (was ${typeof src.url}).`,
    )
    ;(src as { url?: unknown }).url = undefined
  }
  // Also drop empty-string url. Mirror of the tiles[] empty-string
  // filter — an explicit `url: ""` would otherwise emit `url: ""` in
  // the xgis output and the runtime fetch 404'd on every request.
  if (typeof src.url === 'string' && src.url.length === 0) {
    ;(src as { url?: unknown }).url = undefined
  }
  // Drop non-string tile entries so .tiles?.[0] hands downstream a real
  // URL string. A mixed `tiles: [42, "real-url"]` would otherwise pick
  // up the 42 (first index), the regex.test coerced it to "42", and the
  // emitted `url: 42` carried a bare number where xgis expects a
  // quoted string.
  if (Array.isArray(src.tiles)) {
    // Drop non-string entries AND empty strings. Pre-fix `tiles: [""]`
    // passed the string-only filter then `tiles?.[0]` returned an
    // empty string, the URL-fallback chain saw a truthy empty value
    // and emitted `url: ""` — runtime fetch on "" 404s on every tile.
    const filtered = src.tiles.filter(
      (t: unknown): t is string => typeof t === 'string' && t.length > 0,
    )
    if (filtered.length < src.tiles.length) {
      warnings.push(
        `Source "${id}" tiles[] contains non-string or empty entries — dropped ${src.tiles.length - filtered.length}.`,
      )
    }
    ;(src as { tiles?: unknown }).tiles = filtered.length > 0 ? filtered : undefined
  }

  // ── Source-level `tileSize` / `maxzoom` / `minzoom` (#1983) ──────────
  //
  // The xgis grammar parses all three on any source block (ir/lower.ts `lowerSource`
  // → emit-commands.ts `LoadCommand` → SourceDef), but only two source types have a
  // runtime that READS them, and both read them through the same function:
  // `rasterCoverZoom(zoom, tileSize, sourceMaxzoom)` — bias `log2(512/tileSize)`,
  // then clamp to the dataset's deepest real level. `raster` reaches it via
  // RasterRenderer.setTileSize / setSourceMaxzoom, `raster-dem` via
  // HillshadeRenderer.setParams. So those two EMIT the declared values, and every
  // other type keeps a warning: emitting a line nothing reads would be the same
  // silent gap this replaces, not a fix for it.
  const consumesTileProps = src.type === 'raster' || src.type === 'raster-dem'
  /** Extra source-block lines the raster / raster-dem arms append after `url:`. */
  const tileProps: string[] = []
  /** A zoom bound the grammar can actually lower: `lowerSource` matches a bare
   *  NumberLiteral, so a negative value (which parses as a UnaryExpr) would round-trip
   *  to nothing. Emit only what survives; anything else falls to the warning below. */
  const emittableZoom = (v: unknown): number | undefined =>
    consumesTileProps && typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const emitMaxzoom = emittableZoom(src.maxzoom)
  const emitMinzoom = emittableZoom(src.minzoom)
  const droppedZoom = [
    typeof src.minzoom === 'number' && emitMinzoom === undefined ? `minzoom=${src.minzoom}` : '',
    typeof src.maxzoom === 'number' && emitMaxzoom === undefined ? `maxzoom=${src.maxzoom}` : '',
  ].filter(Boolean)
  if (droppedZoom.length > 0) {
    warnings.push(
      `Source "${id}" — source-level ${droppedZoom.join(' / ')} not emitted: only raster / raster-dem sources carry source-level zoom bounds into the runtime, and only as a non-negative number. Out-of-range tiles will be requested and 404; use layer-level minzoom/maxzoom to limit fetch volume.`,
    )
  }
  if (emitMaxzoom !== undefined) tileProps.push(`  maxzoom: ${emitMaxzoom}`)
  if (emitMinzoom !== undefined) {
    tileProps.push(`  minzoom: ${emitMinzoom}`)
    warnings.push(
      `Source "${id}" minzoom: ${emitMinzoom} is emitted and reaches the IR, but there is no source-minzoom consumer in the tile selector yet — only maxzoom clamps the cover zoom — so shallower tiles are still requested. Use layer-level minzoom to limit fetch volume.`,
    )
  }

  // ── Source-level `bounds: [west, south, east, north]` (#1984) ────────
  //
  // The spatial-extent gate: outside the box the source HAS no data, so every request
  // there is a guaranteed 404 spending the same fixed concurrency budget the visible
  // tiles are waiting on. `raster` / `raster-dem` emit it, because those are the two
  // arms whose selectors now clip (`clipTilesToBounds` over `tileIntersectsBounds`,
  // map/src/render/source-bounds-clip.ts). The vector family does NOT: it already
  // clips from its own archive metadata (PMTiles header / TileJSON manifest bounds
  // → `PMTilesBackend.hasTile`), which is authoritative for what the archive actually
  // contains, and re-declaring it in the xgis block would create a second authority.
  //
  // Validity is settled by `checkSourceBounds` — the SAME predicate `lowerSource`
  // applies to a hand-authored block, so the two stages cannot disagree about what a
  // usable box is. An unusable one is dropped, never emitted: emitting it would either
  // blank the source (MapLibre's reading of a crossing/inverted box) or need a
  // wraparound the reference renderer does not implement.
  if (src.bounds !== undefined) {
    const checked = checkSourceBounds(src.bounds)
    if (typeof checked === 'string') {
      warnings.push(
        `Source "${id}" bounds ${checked} — ignored; the source stays unclipped and keeps requesting the full frustum.`,
      )
    } else if (consumesTileProps) {
      tileProps.push(`  bounds: [${checked.join(', ')}]`)
    } else {
      const owner =
        src.type === 'vector' || src.type === 'tilejson' || src.type === 'pmtiles'
          ? "the vector tile path already clips to the ARCHIVE's own extent (PMTiles header / TileJSON manifest bounds), which is authoritative for what the archive actually holds"
          : 'nothing in that load path reads a spatial extent'
      warnings.push(
        `Source "${id}" declares bounds [${checked.join(', ')}]; not emitted for type "${String(src.type)}" — only raster / raster-dem carry a declared extent into the tile selector, and ${owner}.`,
      )
    }
  }

  // ── Source-level `scheme: "xyz" | "tms"` (#1985) ─────────────────────
  //
  // The row origin: `tms` numbers tile rows from the BOTTOM, so the request path
  // substitutes `2^z − 1 − y` for `{y}` (`tileUrl`, data/src/tile-select-helpers.ts —
  // MapLibre's rule verbatim). Emitted for `raster` / `raster-dem`, the two arms whose
  // requests go through that builder. The vector family does NOT reach it: its URLs are
  // built by a SECOND substitution in `data/src/vector-tile-loader.ts` that never sees a
  // SourceDef, and a PMTiles archive is XYZ by specification — so a `scheme` there would
  // be an emitted line nothing reads, the exact silent gap this replaces.
  //
  // `xyz` is the default and is deliberately NOT emitted: an explicit `scheme: xyz` line
  // would mean the same thing as its absence on every source in the corpus. Validity is
  // settled by `isTileScheme` — the SAME predicate `lowerSource` applies to a
  // hand-authored block, so the two stages cannot disagree about the legal value set.
  if (src.scheme !== undefined) {
    if (!isTileScheme(src.scheme)) {
      warnings.push(`Source "${id}" declares scheme ${schemeRejectReason(src.scheme)}.`)
    } else if (src.scheme === 'tms' && consumesTileProps) {
      tileProps.push('  scheme: tms')
    } else if (src.scheme === 'tms') {
      const owner =
        src.type === 'vector' || src.type === 'tilejson' || src.type === 'pmtiles'
          ? "this type's tiles are fetched through a separate substitution (data/src/vector-tile-loader.ts) that has no scheme branch — and a PMTiles archive is XYZ by specification. The tiles will render Y-flipped; point the source at an XYZ endpoint"
          : 'nothing in that load path requests numbered tile rows at all'
      warnings.push(
        `Source "${id}" declares scheme: "tms"; not emitted for type "${String(src.type)}" — only raster / raster-dem carry a row origin into the request path, and ${owner}.`,
      )
    }
  }

  // Mapbox source-level `tileSize` declares the native pixel size of the tile
  // (typically 256 for shaded-relief / older OSM mirrors, 512 for modern raster
  // tiles) and sets the cover-zoom bias `log2(512/tileSize)`. The runtime accepts
  // 256 | 512 ONLY — `RasterRenderer.setTileSize` and `HillshadeRenderer.setParams`
  // both ignore any other value and keep their default — so an exotic size is
  // CLAMPED to the nearer supported one rather than emitted verbatim: emitting 1024
  // would be silently discarded and the source would fall back to the renderer
  // default, two cover-zoom levels from the declared truth instead of one. MapLibre
  // permits arbitrary sizes, but 256 / 512 are the entire real-style corpus.
  const tileSize = (src as { tileSize?: unknown }).tileSize
  if (typeof tileSize === 'number' && consumesTileProps) {
    if (tileSize === 256 || tileSize === 512) {
      tileProps.push(`  tileSize: ${tileSize}`)
    } else if (Number.isFinite(tileSize) && tileSize > 0) {
      // Nearest in LOG space, because the bias is logarithmic: the geometric
      // midpoint √(256·512) ≈ 362 px splits them, so 1024 → 512 and 128 → 256.
      const clamped = tileSize < Math.sqrt(256 * 512) ? 256 : 512
      tileProps.push(`  tileSize: ${clamped}`)
      warnings.push(
        `Source "${id}" declares tileSize: ${tileSize}; the runtime tile grid supports 256 or 512 only, so it is clamped to ${clamped} (nearest in log space — the cover-zoom bias is log2(512/tileSize)). Re-tile the source at 256 or 512 px for an exact match.`,
      )
    } else {
      warnings.push(
        `Source "${id}" tileSize must be a positive number (got ${JSON.stringify(tileSize)}); ignored — the renderer's default tile grid applies.`,
      )
    }
  } else if (typeof tileSize === 'number') {
    warnings.push(
      `Source "${id}" declares tileSize: ${tileSize}, but only raster / raster-dem sources carry it into the runtime; for type "${String(src.type)}" the tile grid falls back to the renderer default.`,
    )
  }

  // Strip the Protomaps-tooling `pmtiles://` scheme prefix + trim
  // leading/trailing whitespace from any URL across all source-type
  // branches. The protomaps/PMTiles library expects a bare URL with
  // no whitespace; passing the prefixed form / whitespace-padded form
  // through to fetch fails (`pmtiles:` scheme / 400 on URL with
  // leading space). (Vector / pmtiles / raster / raster-dem branches
  // all share this helper now.)
  const stripPmtilesScheme = (u: unknown): unknown => {
    if (typeof u !== 'string') return u
    let trimmed = u.trim()
    // Case-insensitive per RFC 3986 §3.1 — schemes ARE case-insensitive
    // ("Although schemes are case-insensitive, the canonical form is
    // lowercase"). A style author writing `PMTILES://...` or
    // `Pmtiles://...` is producing a valid URI; the pre-fix
    // `startsWith('pmtiles://')` check failed those and the verbatim
    // URI fell through to fetch which 400'd on the unknown scheme.
    if (/^pmtiles:\/\//i.test(trimmed)) {
      trimmed = trimmed.slice('pmtiles://'.length)
    }
    return trimmed
  }
  if (Array.isArray(src.tiles)) {
    ;(src as { tiles?: unknown }).tiles = (src.tiles as unknown[]).map(stripPmtilesScheme)
  }
  if (typeof src.url === 'string') {
    ;(src as { url?: unknown }).url = stripPmtilesScheme(src.url)
  }
  // Mapbox tile URL templates can carry placeholders beyond
  // `{z}/{x}/{y}`: `{quadkey}` (Bing tile scheme) and
  // `{bbox-epsg-3857}` (WMS-style bbox in Web Mercator). The X-GIS
  // runtime substitutes ONLY {z}/{x}/{y}; unknown placeholders pass
  // through literally and every tile request 404s with the
  // unsubstituted text in the URL. Surface at convert time so the
  // user sees the gap.
  const checkPlaceholdersOnTiles = (tilesArr: unknown[]): void => {
    for (const t of tilesArr) {
      if (typeof t !== 'string') continue
      if (t.includes('{quadkey}')) {
        warnings.push(
          `Source "${id}" tiles URL uses {quadkey} placeholder (Bing tile scheme); X-GIS runtime substitutes only {z}/{x}/{y} so the request fetches the unsubstituted URL and 404s. Convert the endpoint to the XYZ form.`,
        )
      }
      if (t.includes('{bbox-epsg-3857}')) {
        warnings.push(
          `Source "${id}" tiles URL uses {bbox-epsg-3857} placeholder (WMS-style bbox); X-GIS runtime substitutes only {z}/{x}/{y} so the request fetches the unsubstituted URL and 404s. Use an XYZ tile endpoint instead of WMS.`,
        )
      }
      if (t.includes('{ratio}')) {
        // Runtime substitutes `{ratio}` → "" (1x DPR) at fetch time.
        // No DPR switching yet, so retina endpoints render at 1x;
        // surface as informational so the author knows the @2x
        // ramp isn't picked up.
        warnings.push(
          `Source "${id}" tiles URL uses {ratio} placeholder (Mapbox DPR suffix); runtime substitutes "" (1x DPR) — retina @2x tiles will not be requested until per-DPR selection lands.`,
        )
      }
    }
  }
  if (Array.isArray(src.tiles)) checkPlaceholdersOnTiles(src.tiles as unknown[])
  if (typeof src.url === 'string') checkPlaceholdersOnTiles([src.url])
  if (src.type === 'vector') {
    const url = src.url ?? src.tiles?.[0]
    warnMapboxSchemeUrl(id, url, warnings)
    // #2007 — Mapbox `promoteId` on a vector source remaps a vector-tile
    // property to feature.id (string, or a per-source-layer map). The MVT
    // decoder (data/src/mvt-decoder.ts) reads only the tile's native
    // wire-format `id` field (protobuf tag 1) into GeoJSONFeature.id;
    // promoteId is never consulted anywhere in the pipeline. Same risk as
    // the GeoJSON promoteId warning below (data-driven joins / feature
    // lookups keyed on the promoted property mis-key), previously
    // unwarned for this source type.
    const vectorPromoteId = (src as { promoteId?: unknown }).promoteId
    if (vectorPromoteId !== undefined && vectorPromoteId !== null) {
      warnings.push(
        `Vector source "${id}" declares promoteId; the runtime does not remap vector-tile properties to feature.id — features keep the MVT wire-format id (or none), so data-driven joins keyed on the promoted property may mis-key.`,
      )
    }
    if (url && /\.pmtiles(\?|#|$)/i.test(url)) {
      lines.push('  type: pmtiles')
      lines.push(`  url: ${JSON.stringify(url)}`)
    } else if (url) {
      // Vector source from tiles[] WITHOUT a manifest URL or PMTiles
      // extension must be a per-tile XYZ template. Mirror of the
      // raster/raster-dem placeholder check — a static URL silently
      // makes the runtime detectVectorTileFormat return null, the
      // caller defaults to PMTiles, and the fetch fails with "Wrong
      // magic number" on the non-archive bytes.
      const fromTiles = src.url === undefined && src.tiles?.[0] === url
      const isManifestUrl = /\.(?:json|tilejson)(?:\?|#|$)/i.test(url)
      if (fromTiles && !isManifestUrl) {
        const hasZ = url.includes('{z}')
        const hasX = url.includes('{x}')
        const hasY = url.includes('{y}')
        if (!hasZ || !hasX || !hasY) {
          const missing = [!hasZ && '{z}', !hasX && '{x}', !hasY && '{y}']
            .filter(Boolean)
            .join(', ')
          warnings.push(
            `Vector source "${id}" tiles[0] is missing required URL placeholder${missing.includes(',') ? 's' : ''}: ${missing}. Without {z}/{x}/{y} the runtime tile-format detector returns null and the loader crashes with "Wrong magic number" on the fetched bytes.`,
          )
        }
      }
      lines.push('  type: tilejson')
      lines.push(`  url: ${JSON.stringify(url)}`)
    } else {
      lines.push('  // TODO: vector source without url/tiles — fill in PMTiles archive URL')
      warnings.push(`Source "${id}" has neither url nor tiles[]; emitted placeholder.`)
    }
  } else if (src.type === 'tilejson') {
    // Non-spec but observed in third-party tooling — author writes
    // `"type": "tilejson"` directly instead of relying on `type:
    // vector` + URL sniffing. Accept and route to the runtime's
    // tilejson backend. Without this arm the converter fell to
    // "unsupported source type" and the layer dropped entirely.
    const url = src.url ?? src.tiles?.[0]
    warnMapboxSchemeUrl(id, url, warnings)
    if (url) {
      lines.push('  type: tilejson')
      lines.push(`  url: ${JSON.stringify(url)}`)
    } else {
      lines.push('  // TODO: tilejson source missing url')
      warnings.push(`TileJSON source "${id}" has no URL.`)
    }
  } else if (src.type === 'pmtiles') {
    // Non-spec but common community-extension shape — Protomaps tooling
    // and several third-party styles author `"type": "pmtiles"` directly
    // instead of `"vector"` + relying on URL-extension sniffing. Accept
    // both and route to the same X-GIS pmtiles backend. Without this
    // arm the converter fell to "unsupported source type" and the layer
    // dropped entirely.
    const url = src.url ?? src.tiles?.[0]
    if (url) {
      lines.push('  type: pmtiles')
      lines.push(`  url: ${JSON.stringify(url)}`)
    } else {
      lines.push('  // TODO: pmtiles source missing url')
      warnings.push(`PMTiles source "${id}" has no URL.`)
    }
  } else if (src.type === 'raster') {
    const url = src.tiles?.[0] ?? src.url
    warnMapboxSchemeUrl(id, url, warnings)
    if (url) {
      // tiles[] entries are XYZ URL TEMPLATES — Mapbox spec requires
      // `{z}/{x}/{y}` placeholders. Without all three the runtime
      // fetches the same literal URL for every tile coordinate (and
      // either gets one image painted everywhere or 404s for tile-
      // path servers that demand the coords). Distinguish manifest-
      // shape URLs (`.json` / `.tilejson`) which don't need
      // placeholders.
      const isManifestUrl = /\.(?:json|tilejson)(?:\?|#|$)/i.test(url)
      const fromTiles = src.tiles?.[0] === url
      if (fromTiles && !isManifestUrl) {
        const hasZ = url.includes('{z}')
        const hasX = url.includes('{x}')
        // `{-y}` (the Leaflet/GDAL bottom-origin row) satisfies the row placeholder as of
        // #1985 — `tileUrl` substitutes it — so a working TMS template must not be
        // reported as missing `{y}`. The VECTOR arm above deliberately keeps the strict
        // test: that path builds its URLs in vector-tile-loader.ts, which has no `{-y}`.
        const hasY = url.includes('{y}') || url.includes('{-y}')
        if (!hasZ || !hasX || !hasY) {
          const missing = [!hasZ && '{z}', !hasX && '{x}', !hasY && '{y}']
            .filter(Boolean)
            .join(', ')
          warnings.push(
            `Raster source "${id}" tiles[0] is missing required URL placeholder${missing.includes(',') ? 's' : ''}: ${missing}. The runtime will fetch the same URL for every tile coordinate; expected a template like https://host/{z}/{x}/{y}.png.`,
          )
        }
      }
      lines.push('  type: raster')
      lines.push(`  url: ${JSON.stringify(url)}`)
      lines.push(...tileProps) // tileSize/maxzoom/minzoom (#1983) + bounds (#1984) + scheme (#1985)
    } else {
      lines.push('  // TODO: raster source missing url/tiles')
      warnings.push(`Raster source "${id}" has no URL.`)
    }
  } else if (src.type === 'raster-dem') {
    // Source registered but rendering not yet implemented (Batch 4).
    // Emit type so the runtime's source registry has the entry — a
    // future hillshade / 3D-terrain layer will pick it up.
    const url = src.tiles?.[0] ?? src.url
    warnMapboxSchemeUrl(id, url, warnings)
    if (url) {
      // Mirror of the raster path placeholder check — raster-dem also
      // serves per-tile elevation textures and the URL template needs
      // {z}/{x}/{y} unless it's a TileJSON manifest.
      const isManifestUrl = /\.(?:json|tilejson)(?:\?|#|$)/i.test(url)
      const fromTiles = src.tiles?.[0] === url
      if (fromTiles && !isManifestUrl) {
        const hasZ = url.includes('{z}')
        const hasX = url.includes('{x}')
        const hasY = url.includes('{y}') || url.includes('{-y}') // `{-y}` counts (#1985)
        if (!hasZ || !hasX || !hasY) {
          const missing = [!hasZ && '{z}', !hasX && '{x}', !hasY && '{y}']
            .filter(Boolean)
            .join(', ')
          warnings.push(
            `raster-dem source "${id}" tiles[0] is missing required URL placeholder${missing.includes(',') ? 's' : ''}: ${missing}. Expected a template like https://host/{z}/{x}/{y}.png.`,
          )
        }
      }
      lines.push('  type: raster-dem')
      lines.push(`  url: ${JSON.stringify(url)}`)
      lines.push(...tileProps) // tileSize/maxzoom/minzoom (#1983) + bounds (#1984) + scheme (#1985)
      lines.push(
        '  // NOTE: raster-dem rendering (hillshade / 3D terrain) — Batch 4 of the Mapbox compatibility roadmap.',
      )
      // Mapbox raster-dem elevation encoding (#2003): 'mapbox' (default — RGB-packed
      // elevation à la Terrain RGB) / 'terrarium' (Mapzen / Stamen alternative encoding) /
      // 'custom' (redFactor/greenFactor/blueFactor/baseShift). The runtime decode already
      // threads all three end to end — grammar (ir/lower.ts), interpreter, source-manager,
      // and demUnpack() (map/src/render/hillshade-renderer.ts) — so the converter was the
      // one missing hop: without it every non-mapbox DEM decoded with the mapbox formula
      // regardless of its real pack (saturated-garbage elevation for e.g. a Mapzen/
      // Terrarium source). 'mapbox' is the runtime default and stays emit-omitted —
      // byte-identical to a source that declares no encoding at all.
      const dem = src as {
        encoding?: unknown
        redFactor?: unknown
        greenFactor?: unknown
        blueFactor?: unknown
        baseShift?: unknown
      }
      if (typeof dem.encoding === 'string' && dem.encoding !== 'mapbox') {
        if (dem.encoding === 'terrarium') {
          lines.push('  encoding: terrarium')
        } else if (dem.encoding === 'custom') {
          lines.push('  encoding: custom')
          // Only a non-negative finite number lowers: lowerSource matches a bare
          // NumberLiteral for each factor (mirrors the emittableZoom rule above) — a
          // negative value parses as a UnaryExpr and would round-trip to nothing. A lane
          // left out (or unusable) falls back to the mapbox factor for that lane —
          // demUnpack()'s documented behaviour — so a partial custom pack (e.g. only
          // redFactor) is a legitimate style, not an error.
          const factor = (v: unknown): number | undefined =>
            typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
          const redFactor = factor(dem.redFactor)
          const greenFactor = factor(dem.greenFactor)
          const blueFactor = factor(dem.blueFactor)
          const baseShift = factor(dem.baseShift)
          if (redFactor !== undefined) lines.push(`  redFactor: ${redFactor}`)
          if (greenFactor !== undefined) lines.push(`  greenFactor: ${greenFactor}`)
          if (blueFactor !== undefined) lines.push(`  blueFactor: ${blueFactor}`)
          if (baseShift !== undefined) lines.push(`  baseShift: ${baseShift}`)
        } else {
          warnings.push(
            `raster-dem source "${id}" declares encoding="${dem.encoding}" — neither "terrarium" nor "custom" nor the default "mapbox"; not emitted, so the runtime falls back to the mapbox pack formula (demUnpack()'s own fallback for any unrecognised encoding).`,
          )
        }
      }
      warnings.push(
        `Source "${id}" type="raster-dem" registered but rendering not yet supported (Batch 4 — hillshade + 3D terrain).`,
      )
    } else {
      lines.push('  // TODO: raster-dem source missing url/tiles')
      warnings.push(`raster-dem source "${id}" has no URL.`)
    }
  } else if (src.type === 'geojson') {
    // ── Source-level point clustering (#2050) ────────────────────────
    //
    // Mapbox `cluster` + its four tuning fields instruct MapLibre to aggregate the point
    // features into supercluster hierarchies. They now REACH the IR: `convertSourceCluster`
    // renders the source-block lines (and every diagnostic for a value that cannot be
    // carried), `lowerSource` claims the same five keys through the shared `CLUSTER_KEY`
    // table, and P2/P3 of the clustering track build the index that reads them. The lines
    // are appended at the END of this arm, after the type/url/data emit.
    const clusterLines = convertSourceCluster(id, src, warnings)
    // Mapbox GeoJSON tuning fields: `tolerance` (Douglas-Peucker
    // simplification), `buffer` (tile-clip padding), `lineMetrics`
    // (line-progress accessor for line-gradient), `maxzoom`,
    // `attribution`, `generateId`. X-GIS's GeoJSON pipeline uses
    // hand-tuned defaults; none of these are honoured.
    const geoCfg = src as {
      tolerance?: unknown
      buffer?: unknown
      lineMetrics?: unknown
      generateId?: unknown
      attribution?: unknown
    }
    const geoIgnored: string[] = []
    if (geoCfg.tolerance !== undefined && geoCfg.tolerance !== null) geoIgnored.push('tolerance')
    if (geoCfg.buffer !== undefined && geoCfg.buffer !== null) geoIgnored.push('buffer')
    if (geoCfg.lineMetrics === true) geoIgnored.push('lineMetrics (line-gradient prerequisite)')
    if (geoCfg.generateId === true) geoIgnored.push('generateId')
    if (geoIgnored.length > 0) {
      warnings.push(`GeoJSON source "${id}" — ignored tuning fields: ${geoIgnored.join(', ')}`)
    }
    // `promoteId` selects which feature property becomes feature.id —
    // used by Mapbox `["id"]` accessor + map.setFeatureState(). X-GIS
    // doesn't promote ids today; `["id"]` resolves to whatever the
    // source data carries on the id slot, undefined when absent.
    const promoteId = (src as { promoteId?: unknown }).promoteId
    if (promoteId !== undefined && promoteId !== null) {
      warnings.push(
        `GeoJSON source "${id}" declares promoteId; the runtime doesn't promote feature properties to feature.id, so the ["id"] accessor reads the original id slot only.`,
      )
    }
    const data = (src as { data?: string | unknown }).data
    if (typeof data === 'string') {
      // Defensive: empty-string URL would emit `url: ""` and the
      // runtime fetch on "" hits the current document URL and
      // either returns the host HTML or 404s on a SPA. Pre-fix the
      // empty string fell through to the URL emit path silently;
      // treat it the same as missing data field for consistency
      // with the source.url empty-string guard above.
      if (data.length === 0) {
        lines.push('  // TODO: GeoJSON source data field is empty string')
        warnings.push(`GeoJSON source "${id}" data field is an empty string; treated as missing.`)
      } else {
        // External URL — runtime fetches and decodes lazily.
        lines.push('  type: geojson')
        lines.push(`  url: ${JSON.stringify(data)}`)
      }
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
        lines.push(
          '  // inline data — call map.setSourceData("' +
            safeId +
            '", <FeatureCollection>) after run()',
        )
        // Catch circular references — JSON.stringify throws TypeError
        // on cycles. Pre-fix the throw propagated up and crashed the
        // whole convertMapboxStyle call. Inline preview is purely
        // informational so we can downgrade to a notice line.
        let json: string
        try {
          json = JSON.stringify(data)
        } catch (e) {
          json = `[unserialisable: ${(e as Error).message.slice(0, 60)}]`
        }
        if (json.length > 2000) {
          lines.push(
            `  // data: ${json.slice(0, 2000)}...  (truncated, ${json.length} bytes total)`,
          )
        } else {
          lines.push(`  // data: ${json}`)
        }
        warnings.push(
          `GeoJSON source "${id}" has inline data — emitted as no-URL stub; call map.setSourceData() after run().`,
        )
      }
    } else if (data === undefined || data === null) {
      lines.push('  // TODO: GeoJSON source missing data field')
      warnings.push(
        `GeoJSON source "${id}" has no data field. Set source.data to a URL string OR an inline FeatureCollection / Feature / Geometry object.`,
      )
    } else {
      // data is some other type (boolean, number, etc.) — distinct
      // from missing. Mapbox spec requires data to be string (URL)
      // or object (inline). Pre-fix any non-string non-object value
      // fell to the "missing" warning, sending users chasing the
      // wrong fix when the real issue was a wrong-shape value.
      lines.push(`  // TODO: GeoJSON source data field has invalid type (${typeof data})`)
      warnings.push(
        `GeoJSON source "${id}" data field must be a URL string or inline object; got ${typeof data}.`,
      )
    }
    lines.push(...clusterLines) // cluster / clusterRadius / … (#2050)
  } else if (src.type === 'image' || src.type === 'video') {
    lines.push(`  // SKIPPED: ${src.type} source not yet supported by X-GIS engine`)
    warnings.push(
      `Source "${id}" type="${src.type}" — image/video sources not yet supported (no roadmap entry; file an issue if needed).`,
    )
  } else if (src.type === undefined || src.type === null) {
    // Mapbox spec requires `type` per source — undefined/null is a
    // distinct failure mode from "unsupported type string". Pre-fix
    // both fell through to the same generic catch-all and emitted
    // `unsupported type "undefined"` which is confusing because the
    // real fix is "add a type field" not "switch to a different
    // type string".
    lines.push('  // TODO: source missing required `type` field')
    warnings.push(
      `Source "${id}" is missing the required type field. Mapbox spec requires type: vector|raster|raster-dem|geojson|image|video.`,
    )
  } else if (typeof src.type !== 'string') {
    // Non-string type — same isolated failure path. Note the actual
    // typeof in the warning so the user sees the shape mismatch.
    lines.push(`  // TODO: source type is non-string (${typeof src.type})`)
    warnings.push(`Source "${id}" type field must be a string (got ${typeof src.type}).`)
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
  const obj = data as {
    type?: string
    features?: unknown[]
    geometry?: unknown
    properties?: unknown
    geometries?: unknown[]
  }
  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return obj
  if (obj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [obj] }
  }
  // GeometryCollection at the top level — RFC 7946 §3.1.8 spec-permitted.
  // Wrap as a single Feature with the collection as geometry; the
  // runtime loadGeoJSON (iter 452) then flattens the sub-geometries.
  if (obj.type === 'GeometryCollection' && Array.isArray(obj.geometries)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: obj, properties: {} }],
    }
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

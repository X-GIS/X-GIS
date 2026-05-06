// PMTiles → TileCatalog bridge — lazy / on-demand.
//
// Architecture:
//   • Open the archive, read its header (single HTTP request via the
//     pmtiles client) to learn bounds + zoom range + tile type.
//   • Register a VirtualCatalog on the TileCatalog carrying that
//     metadata + a fetcher closure that decodes one MVT and runs it
//     through compileSingleTile when invoked.
//   • TileCatalog.requestTiles → fetcher → cacheTileData → onTileLoaded
//     → VTR uploads. Driven entirely by the renderer's per-frame
//     visible-tile selection — only tiles the camera reaches are
//     fetched. Matches PMTiles' design intent (HTTP byte-range
//     streaming, not bulk download).
//
import { PMTiles, TileType, type Header } from 'pmtiles'
import { TileCatalog } from '../data/tile-catalog'
import { PMTilesBackend } from '../data/sources/pmtiles-backend'

/** Module-level archive cache keyed by URL.
 *
 *  The pmtiles client maintains its own LRU cache of byte-range
 *  fetches per `PMTiles` instance. By default we'd `new PMTiles(url)`
 *  every time `attachPMTilesSource()` is called — fresh instance,
 *  fresh empty cache, every header + tile re-fetched. Reusing the
 *  instance per URL means:
 *    • Hot xgis re-runs (user edits style + reloads) skip the header
 *      round-trip.
 *    • Switching demos between two xgis files that share an archive
 *      keeps already-fetched tile bytes warm.
 *    • Layer add/remove inside one editor session never refetches.
 *
 *  Header + metadata are cached alongside the archive so we don't
 *  re-await getHeader() / getMetadata() on subsequent attachments. */
interface CachedArchive {
  archive: PMTiles
  header: Header
  vectorLayers: VectorLayerInfo[]
  archiveName?: string
  attribution?: string
}
const archiveCache = new Map<string, Promise<CachedArchive>>()

/** Test/dev hook — drop the cache (e.g., to force re-fetch in unit
 *  tests or after a known-stale archive update). Clears both the
 *  PMTiles archive cache and the TileJSON manifest cache. */
export function clearPMTilesArchiveCache(): void {
  archiveCache.clear()
  // tileJsonCache is declared further down (the TileJSON support
  // section); guard so this still works in environments where the
  // section was tree-shaken or the export is called before init.
  if (typeof tileJsonCache !== 'undefined') tileJsonCache.clear()
}

export interface PMTilesSourceOptions {
  url: string
  /** Restrict to a subset of MVT layer names (default: all layers). */
  layers?: string[]
}

/** Per-MVT-layer info pulled from PMTiles `metadata.vector_layers`.
 *  Used by the runtime to skip work when the current camera zoom is
 *  outside a layer's data range — protomaps v4 only carries `roads`
 *  at z≥6 and `buildings` at z≥14, so requesting them at z=0/z=3
 *  would otherwise trigger FLICKER warnings + sub-tile generation
 *  for tiles the archive simply doesn't have features in. */
export interface VectorLayerInfo {
  id: string
  minzoom: number
  maxzoom: number
  fields?: Record<string, string>
}

/** Open a PMTiles archive (or return a cached open one). Caches by
 *  URL including header + metadata so repeated attaches skip the
 *  HTTP round-trips entirely. Returns a Promise so concurrent calls
 *  for the same URL share one in-flight fetch. */
async function openCachedArchive(url: string): Promise<CachedArchive> {
  const hit = archiveCache.get(url)
  if (hit) return hit
  const promise = (async (): Promise<CachedArchive> => {
    const archive = new PMTiles(url)
    const header = await archive.getHeader()
    if (header.tileType !== TileType.Mvt) {
      throw new Error(`[pmtiles-source] tileType ${header.tileType} not supported — only MVT (1)`)
    }
    let vectorLayers: VectorLayerInfo[] = []
    let archiveName: string | undefined
    let attribution: string | undefined
    try {
      const meta = await archive.getMetadata() as {
        name?: string
        attribution?: string
        vector_layers?: Array<{
          id: string
          minzoom?: number
          maxzoom?: number
          fields?: Record<string, string>
        }>
      } | null
      if (meta) {
        archiveName = meta.name
        attribution = meta.attribution
        if (Array.isArray(meta.vector_layers)) {
          vectorLayers = meta.vector_layers.map(vl => ({
            id: vl.id,
            minzoom: vl.minzoom ?? header.minZoom,
            maxzoom: vl.maxzoom ?? header.maxZoom,
            fields: vl.fields,
          }))
        }
      }
    } catch (e) {
      console.warn(`[X-GIS] PMTiles metadata fetch failed (non-fatal): ${(e as Error)?.message ?? e}`)
    }
    return { archive, header, vectorLayers, archiveName, attribution }
  })()
  // Drop the entry on failure so the next attach retries instead of
  // resolving the cached rejection forever.
  promise.catch(() => archiveCache.delete(url))
  archiveCache.set(url, promise)
  return promise
}

// ─── TileJSON support ───
//
// Some MVT vector tile providers (e.g., protomaps API at
// api.protomaps.com/tiles/v4.json) don't ship as a single PMTiles
// archive — they expose a TileJSON manifest pointing at an XYZ tile
// server (`/tiles/v4/{z}/{x}/{y}.mvt?key=...`). The PMTilesBackend
// only depends on a `fetcher: (z, x, y) => Promise<Uint8Array>`
// closure, so we can support TileJSON by fetching tiles via the URL
// template instead of byte-range from a single archive — same backend,
// same MVT decoder, same compile pipeline.

interface CachedTileJSON {
  tilesTemplate: string
  bounds: [number, number, number, number]
  minzoom: number
  maxzoom: number
  vectorLayers: VectorLayerInfo[]
  name?: string
  attribution?: string
}
const tileJsonCache = new Map<string, Promise<CachedTileJSON>>()

interface RawTileJSON {
  tilejson?: string
  tiles?: string[]
  bounds?: [number, number, number, number]
  minzoom?: number
  maxzoom?: number
  name?: string
  attribution?: string
  vector_layers?: Array<{
    id: string
    minzoom?: number
    maxzoom?: number
    fields?: Record<string, string>
  }>
}

async function openCachedTileJSON(url: string): Promise<CachedTileJSON> {
  const hit = tileJsonCache.get(url)
  if (hit) return hit
  const promise = (async (): Promise<CachedTileJSON> => {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`TileJSON ${url} returned HTTP ${resp.status}`)
    const tj = await resp.json() as RawTileJSON
    if (!tj.tiles || tj.tiles.length === 0) {
      throw new Error(`TileJSON ${url}: missing or empty tiles[] template`)
    }
    const tilesTemplate = tj.tiles[0]
    const minzoom = tj.minzoom ?? 0
    const maxzoom = tj.maxzoom ?? 14
    const bounds: [number, number, number, number] =
      tj.bounds ?? [-180, -85.0511287, 180, 85.0511287]
    const vectorLayers: VectorLayerInfo[] = (tj.vector_layers ?? []).map(vl => ({
      id: vl.id,
      minzoom: vl.minzoom ?? minzoom,
      maxzoom: vl.maxzoom ?? maxzoom,
      fields: vl.fields,
    }))
    return {
      tilesTemplate, bounds, minzoom, maxzoom, vectorLayers,
      name: tj.name,
      attribution: tj.attribution,
    }
  })()
  promise.catch(() => tileJsonCache.delete(url))
  tileJsonCache.set(url, promise)
  return promise
}

/** Heuristic: does this URL look like a TileJSON manifest rather than
 *  a single .pmtiles archive? Checks the path tail; query strings (api
 *  key params) are stripped before the test. Falls through to false
 *  for ambiguous URLs — those still hit the PMTiles archive path,
 *  which surfaces a parse error if the response is actually JSON. */
function looksLikeTileJSON(url: string): boolean {
  const path = url.split('?')[0]
  if (path.endsWith('.tilejson')) return true
  // `.json` but not `.geojson` — `.geojson` URLs are GeoJSON data
  // (handled by a different loader), and including them here would
  // mis-route any GeoJSON source declared with `type: pmtiles` (rare,
  // but the gate should be honest about its detection rule).
  return path.endsWith('.json') && !path.endsWith('.geojson')
}

/** Per-URL "last error logged at" timestamp (ms). Lets the fetcher
 *  log a transient 5xx once per minute per URL pattern instead of
 *  flooding the console — important when 100+ tiles share an upstream
 *  blip and would otherwise stack 100+ identical error messages. */
const tileFetchLogThrottle = new Map<string, number>()
const TILE_FETCH_LOG_INTERVAL_MS = 60_000

/** Negative cache for individual tile URLs that exhausted retry —
 *  during the TTL we return null IMMEDIATELY without hitting the
 *  network. Without this, a tile that's reproducibly 504 (e.g.,
 *  api.protomaps.com sometimes has a permanent origin issue on a
 *  specific (z,x,y) — observed on tile 2/2/2 in the v4 daily build)
 *  would burn the retry budget on every visible-tile pass forever:
 *  ~1.2 s of wasted backoff sleep + 3 hopeless network roundtrips
 *  per affected tile per render. The 5-minute TTL covers
 *  short-to-medium outages while still giving protomaps' side a
 *  chance to recover without a page reload. */
const tileFetchNegativeCache = new Map<string, number>()
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000

/** Single-tile fetch with retry + graceful null fallback for transient
 *  upstream failures (5xx, network errors). Returns:
 *
 *  - `Uint8Array` — successful fetch (200/206 with bytes)
 *  - `null`        — tile is missing (404 / 204) OR exhausted retries
 *                    on a transient error. The catalog treats null as
 *                    "no data here, try again on next visible-tile
 *                    pass" — same contract as the PMTiles archive
 *                    backend's null return.
 *
 *  Backoff: 300 ms, then 900 ms (max 2 retries → 3 attempts total).
 *  Tuned for transient CDN edge timeouts (~1-2 s typical recovery)
 *  without hammering origin during a real outage. */
async function fetchTileWithRetry(url: string, tileLabel: string): Promise<Uint8Array | null | 'failed'> {
  // Negative cache hit — short-circuit with 'failed' so the
  // PMTilesBackend keeps the tile in its failedKeys map (parent
  // fallback). Without this guard, every frame burns the retry
  // budget hitting an upstream that's reproducibly broken.
  const negativeExpiry = tileFetchNegativeCache.get(url)
  if (negativeExpiry !== undefined) {
    if (Date.now() < negativeExpiry) return 'failed'
    tileFetchNegativeCache.delete(url)
  }
  const backoffsMs = [300, 900]
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      const resp = await fetch(url)
      // Tile genuinely missing — final answer, don't retry.
      if (resp.status === 404 || resp.status === 204) return null
      if (resp.ok) {
        const buf = await resp.arrayBuffer()
        return new Uint8Array(buf)
      }
      // 5xx (502 Bad Gateway, 503 Service Unavailable, 504 Gateway
      // Timeout, etc.): retryable. 4xx other than 404: also retry —
      // some CDNs return spurious 403/429 under burst load.
      lastErr = new Error(`${tileLabel}: HTTP ${resp.status}`)
    } catch (e) {
      // Network error (DNS, TLS, abort, etc.). Retryable.
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
    // Out of retries — fall through to graceful null.
    if (attempt === backoffsMs.length) break
    await new Promise(r => setTimeout(r, backoffsMs[attempt]))
  }
  // All retries failed — cache this URL as "do not retry for a while"
  // so subsequent frames skip the wasted retry sleep + roundtrip.
  // We return 'failed' (not null) so PMTilesBackend keeps the tile
  // in its missing-state failedKeys map, letting the renderer's
  // parent-walk fall back to the nearest cached ancestor instead of
  // caching an empty tile here.
  tileFetchNegativeCache.set(url, Date.now() + NEGATIVE_CACHE_TTL_MS)

  // Throttled log: once per URL pattern per minute. Strip the (z, x, y)
  // path from the URL so a burst of related tile failures shares a
  // single log line instead of stacking 100 identical entries.
  const urlKey = url.replace(/\/\d+\/\d+\/\d+/, '/{z}/{x}/{y}')
  const now = Date.now()
  const lastLogged = tileFetchLogThrottle.get(urlKey) ?? 0
  if (now - lastLogged > TILE_FETCH_LOG_INTERVAL_MS) {
    tileFetchLogThrottle.set(urlKey, now)
    console.warn(
      `[X-GIS] ${tileLabel} fetch failed after ${backoffsMs.length + 1} attempts ` +
      `(${lastErr?.message ?? 'unknown error'}). ` +
      `Caching as missing for ${NEGATIVE_CACHE_TTL_MS / 60_000} min — that area will render empty. ` +
      `If this is a 5xx from a tile server, it's likely an upstream data-build issue ` +
      `for this specific (z, x, y); the rest of the map continues to load normally. ` +
      `(Further failures matching ${urlKey} suppressed for ${TILE_FETCH_LOG_INTERVAL_MS / 1000}s.)`,
    )
  }
  return 'failed'
}

/** Attach a PMTiles archive (or a TileJSON / XYZ MVT tile server) to
 *  an existing TileCatalog as a lazy virtual catalog. Returns once the
 *  header / TileJSON manifest is read; tiles are fetched on-demand
 *  from that point on. */
export async function attachPMTilesSource(
  source: TileCatalog,
  opts: PMTilesSourceOptions,
): Promise<void> {
  // ── TileJSON dispatch ──
  if (looksLikeTileJSON(opts.url)) {
    let tj: CachedTileJSON
    try {
      tj = await openCachedTileJSON(opts.url)
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      console.error(
        `[X-GIS] TileJSON attach failed for ${opts.url}\n` +
        `  ${msg}\n` +
        `  If this is "Failed to fetch", the manifest's origin lacks\n` +
        `  Access-Control-Allow-Origin for your origin. Use a host\n` +
        `  that allows your origin in its CORS settings.`,
      )
      return
    }
    const layerSummary = tj.vectorLayers.length > 0
      ? ` | layers: ${tj.vectorLayers.map(l => `${l.id}(z${l.minzoom}-${l.maxzoom})`).join(', ')}`
      : ''
    console.log(
      `[X-GIS] TileJSON attached${tj.name ? ` "${tj.name}"` : ''}: ` +
      `z=${tj.minzoom}..${tj.maxzoom}, ` +
      `bounds=[${tj.bounds.join(', ')}], ` +
      `template=${tj.tilesTemplate}${layerSummary}`,
    )
    if (tj.attribution) console.log(`[X-GIS] TileJSON attribution: ${tj.attribution}`)
    if (opts.layers && tj.vectorLayers.length > 0) {
      const known = new Set(tj.vectorLayers.map(l => l.id))
      for (const lname of opts.layers) {
        if (!known.has(lname)) {
          console.warn(
            `[X-GIS] TileJSON: requested layer "${lname}" is not in ` +
            `vector_layers. Known: [${tj.vectorLayers.map(l => l.id).join(', ')}].`,
          )
        }
      }
    }
    source.attachBackend(new PMTilesBackend({
      minZoom: tj.minzoom,
      maxZoom: tj.maxzoom,
      bounds: tj.bounds,
      layers: opts.layers,
      vectorLayers: tj.vectorLayers,
      // XYZ template fetcher with retry + graceful fallback.
      // `fetch()` auto-decompresses gzip via Content-Encoding, so the
      // bytes are raw MVT (same shape PMTilesBackend expects from the
      // archive path). 404 / 204 = missing tile (final). 5xx + network
      // errors → retry with backoff (300ms, 900ms), then null — see
      // fetchTileWithRetry above for the recovery semantics.
      fetcher: async (z, x, y) => {
        const url = tj.tilesTemplate
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
        return fetchTileWithRetry(url, `tile ${z}/${x}/${y}`)
      },
    }))
    return
  }

  // ── PMTiles archive dispatch (original path) ──
  let cached: CachedArchive
  try {
    cached = await openCachedArchive(opts.url)
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error(
      `[X-GIS] PMTiles attach failed for ${opts.url}\n` +
      `  ${msg}\n` +
      `  If this is "Failed to fetch", the archive's origin likely\n` +
      `  doesn't set Access-Control-Allow-Origin. Use a CORS-enabled\n` +
      `  host (e.g. pmtiles.io) or proxy the archive through your dev\n` +
      `  server (vite.config.ts proxy entry).`,
    )
    return  // soft-fail: catalog stays empty, demo still loads
  }
  const { archive, header, vectorLayers, archiveName, attribution } = cached

  const layerSummary = vectorLayers.length > 0
    ? ` | layers: ${vectorLayers.map(l => `${l.id}(z${l.minzoom}-${l.maxzoom})`).join(', ')}`
    : ''
  console.log(
    `[X-GIS] PMTiles attached${archiveName ? ` "${archiveName}"` : ''}: ` +
    `z=${header.minZoom}..${header.maxZoom}, ` +
    `bounds=[${header.minLon.toFixed(4)}, ${header.minLat.toFixed(4)}, ` +
    `${header.maxLon.toFixed(4)}, ${header.maxLat.toFixed(4)}], ` +
    `${header.numTileEntries} tile entries${layerSummary}`,
  )
  if (attribution) console.log(`[X-GIS] PMTiles attribution: ${attribution}`)

  // Validate user's layer filter against advertised vector_layers —
  // catches typos in `sourceLayer: "buidings"` style declarations.
  if (opts.layers && vectorLayers.length > 0) {
    const known = new Set(vectorLayers.map(l => l.id))
    for (const lname of opts.layers) {
      if (!known.has(lname)) {
        console.warn(
          `[X-GIS] PMTiles: requested layer "${lname}" is not in archive's ` +
          `vector_layers. Known: [${vectorLayers.map(l => l.id).join(', ')}].`,
        )
      }
    }
  }

  // Fetcher returns RAW MVT bytes only. PMTilesBackend defers decode +
  // compileSingleTile to its tick() so the heavy work is paced across
  // frames instead of blocking the main thread when many fetches
  // resolve in the same microtask boundary.
  source.attachBackend(new PMTilesBackend({
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    layers: opts.layers,
    vectorLayers,
    fetcher: async (z, x, y) => {
      const resp = await archive.getZxy(z, x, y)
      return resp ? new Uint8Array(resp.data) : null
    },
  }))
}

/** Convenience: create a fresh TileCatalog and attach a PMTiles archive
 *  in one call. Use {@link attachPMTilesSource} when you need to wire
 *  the source's onTileLoaded hook (or other listeners) before the
 *  archive is opened. */
export async function loadPMTilesSource(
  opts: PMTilesSourceOptions,
): Promise<TileCatalog> {
  const source = new TileCatalog()
  await attachPMTilesSource(source, opts)
  return source
}

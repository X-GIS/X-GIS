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
import { tileKey } from '@xgis/compiler'
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

/** Memoize an in-flight fetch by URL: dedupes concurrent callers, evicts
 *  on rejection so the next call retries instead of resolving the cached
 *  failure forever. Used by both the PMTiles archive opener and the
 *  TileJSON manifest opener — same coordination, one helper. */
function memoizeOpen<T>(
  cache: Map<string, Promise<T>>,
  url: string,
  factory: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(url)
  if (hit) return hit
  const promise = factory()
  promise.catch(() => cache.delete(url))
  cache.set(url, promise)
  return promise
}

/** Normalize a TileJSON / PMTiles `vector_layers[]` entry. Both
 *  formats use the same shape but different default-zoom plumbing, so
 *  the per-layer minzoom/maxzoom fall back to the SOURCE's overall
 *  zoom range when a layer omits them. Shared helper keeps the two
 *  fallback chains identical. */
function normalizeVectorLayers(
  raw: Array<{ id: string; minzoom?: number; maxzoom?: number; fields?: Record<string, string> }> | undefined,
  defaultMin: number,
  defaultMax: number,
): VectorLayerInfo[] {
  return (raw ?? []).map(vl => ({
    id: vl.id,
    minzoom: vl.minzoom ?? defaultMin,
    maxzoom: vl.maxzoom ?? defaultMax,
    fields: vl.fields,
  }))
}

/** Single entry point for cold-start metadata prefetch — auto-detects
 *  format from the URL/kind and primes the appropriate cache so the
 *  later `attachPMTilesSource` call sees a hit instead of awaiting
 *  the 100-400 ms header round-trip. Fire-and-forget; errors are
 *  swallowed so a bad URL falls through to the regular attach path
 *  where the same fetch surfaces the error normally. XGVT-binary
 *  URLs are a no-op here — the binary backend manages its own byte-
 *  range cache through `loadFromURL`, not an HTTP prewarm. */
export function prewarmVectorTileSource(
  url: string,
  kind?: 'pmtiles' | 'tilejson' | 'xgvt' | 'auto',
): void {
  const format = detectVectorTileFormat(url, kind)
  if (format === 'tilejson') {
    if (!tileJsonCache.has(url)) void openCachedTileJSON(url).catch(() => undefined)
  } else if (format === 'pmtiles') {
    if (!archiveCache.has(url)) void openCachedArchive(url).catch(() => undefined)
  }
  // 'xgvt' / null: nothing to prewarm at this layer.
}

/** Fetch the union of `vector_layers[*].fields` from a PMTiles
 *  archive's metadata. Returns a FLAT `name → declared-type` map.
 *  Kept for back-compat — callers that need per-source-layer
 *  scoping should use {@link fetchPMTilesVectorLayerSchema}. */
export async function fetchPMTilesVectorLayerFields(
  url: string,
): Promise<Record<string, string> | null> {
  const schema = await fetchPMTilesVectorLayerSchema(url)
  if (!schema) return null
  const merged: Record<string, string> = {}
  for (const fields of Object.values(schema)) {
    for (const [k, v] of Object.entries(fields)) merged[k] = v
  }
  return Object.keys(merged).length > 0 ? merged : null
}

/** Per-source-layer field schema from PMTiles metadata. The shape
 *  is `{ [sourceLayerId]: { [fieldName]: declaredType } }` —
 *  exactly the data the editor needs to filter `.field`
 *  autocomplete to the layer the cursor is in (`sourceLayer:
 *  "buildings"` should suggest building fields, not road fields).
 *
 *  Returns null when the archive has no vector_layers metadata
 *  or the fetch fails. */
export async function fetchPMTilesVectorLayerSchema(
  url: string,
): Promise<Record<string, Record<string, string>> | null> {
  try {
    const cached = await openCachedArchive(url)
    const out: Record<string, Record<string, string>> = {}
    for (const vl of cached.vectorLayers) {
      if (!vl.fields) continue
      out[vl.id] = { ...vl.fields }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

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
  /** Explicit declaration of what's at the URL. Bypasses URL-extension
   *  sniffing when the caller already knows the format (`.pmtiles` is
   *  unambiguous; `.json` could be TileJSON or GeoJSON; manifest URLs
   *  often have no extension at all). Default `'auto'`.
   *
   *  - `'pmtiles'` — single .pmtiles archive, byte-range MVT.
   *  - `'tilejson'` — TileJSON manifest pointing at an XYZ MVT server.
   *  - `'xgvt'` — native X-GIS binary archive (`source.loadFromURL`).
   *  - `'auto'` — sniff by URL extension. */
  kind?: 'pmtiles' | 'tilejson' | 'xgvt' | 'auto'
  /** Restrict to a subset of MVT layer names (default: all layers). */
  layers?: string[]
  /** Per-MVT-layer 3D-extrude expression AST. Driven by the
   *  compiler's `extrude:` keyword and forwarded into the backend so
   *  the MVT decode worker evaluates the AST per feature to compute
   *  its 3D height. Layers without an entry use the worker's default
   *  extraction (`render_height ?? height`). */
  extrudeExprs?: Record<string, unknown>
  /** Per-MVT-layer 3D-extrude BASE expression AST (Mapbox
   *  `fill-extrusion-base`). Worker eval per feature, result is the
   *  wall-bottom z (default 0). */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. Each entry says "produce a slice
   *  with this sliceKey, drawing only `sourceLayer` features that
   *  pass `filterAst`." Without it, the backend falls back to one
   *  slice per source layer (legacy). */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null }>
  /** Per-sliceKey stroke-width override AST. Synthesized by the
   *  compiler's mergeLayers pass when grouping same-source-layer
   *  layers with different widths. The worker evaluates per feature
   *  and writes resolved width into the line segment buffer. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. Companion to
   *  strokeWidthExprs — mergeLayers folds groups with different
   *  stroke colours by baking the per-feature colour as packed
   *  RGBA8 into the segment buffer. */
  strokeColorExprs?: Record<string, unknown>
  /** Maximum zoom level (inclusive) for the global low-zoom
   *  skeleton that's pre-fetched and pinned in TileCatalog right
   *  after attach. Mirrors Cesium `QuadtreePrimitive`'s permanent
   *  root subtree / NASA-AMMOS 3D Tiles Renderer's protected
   *  `lruCache` anchors / Google Earth's permanent base layer —
   *  guarantees `classifyFallback`'s ancestor walk always finds a
   *  cached tile during fast-pan, eliminating the white-tile flash
   *  caused by the `pending` decision returning no fallback
   *  geometry. Defaults to `defaultSkeletonDepth()` — viewport-
   *  aware (mobile 2 / desktop 3); set to 0 to disable, or to a
   *  larger value to trade memory for coverage of layers whose
   *  vector_layer minzoom is high (e.g. transportation z=4 wants
   *  depth ≥ 4 to be in the skeleton's ancestor chain). */
  prewarmSkeletonDepth?: number
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
  return memoizeOpen(archiveCache, url, async () => {
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
        vectorLayers = normalizeVectorLayers(meta.vector_layers, header.minZoom, header.maxZoom)
      }
    } catch (e) {
      console.warn(`[X-GIS] PMTiles metadata fetch failed (non-fatal): ${(e as Error)?.message ?? e}`)
    }
    return { archive, header, vectorLayers, archiveName, attribution }
  })
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
  return memoizeOpen(tileJsonCache, url, async () => {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`TileJSON ${url} returned HTTP ${resp.status}`)
    const tj = await resp.json() as RawTileJSON
    if (!tj.tiles || tj.tiles.length === 0) {
      throw new Error(`TileJSON ${url}: missing or empty tiles[] template`)
    }
    const minzoom = tj.minzoom ?? 0
    const maxzoom = tj.maxzoom ?? 14
    return {
      tilesTemplate: tj.tiles[0],
      bounds: tj.bounds ?? [-180, -85.0511287, 180, 85.0511287],
      minzoom, maxzoom,
      vectorLayers: normalizeVectorLayers(tj.vector_layers, minzoom, maxzoom),
      name: tj.name,
      attribution: tj.attribution,
    }
  })
}

/** The vector tile formats this loader knows how to attach. `null`
 *  means "the URL doesn't look like any of these" — the caller (e.g.
 *  the data-load loop in map.ts) routes to a different branch
 *  (raster, GeoJSON, etc.). */
export type VectorTileFormat = 'pmtiles' | 'tilejson' | 'xgvt'

/** Single source of truth for "what format is at `url`". Used by
 *  the data-load loop to decide if a load is a vector tile source at
 *  all, by `attachPMTilesSource` to pick which backend path to take,
 *  and by `prewarmVectorTileSource` to pick which cache to prime.
 *
 *  Routing precedence (most-authoritative first):
 *    1. URL extension is decisive when present (`.tilejson` / `.json`,
 *       `.pmtiles`, `.xgvt`). The server is the source of truth for
 *       what bytes come back — an explicit `kind: pmtiles` from a
 *       stale xgis source can't override a `.json` URL (that broke the
 *       protomaps `.pmtiles → api.protomaps.com/v4.json?key=…` rewrite
 *       with "Wrong magic number" before the URL-wins rule landed).
 *       `.geojson` is excluded so feature-data URLs aren't mis-routed.
 *    2. Otherwise honour explicit `kind` ('pmtiles' / 'tilejson' / 'xgvt').
 *    3. Fall through to `null` — caller decides what to do with the
 *       unknown URL (most paths that pre-decided "this is a vector
 *       tile" supply `kind` so we never reach this in practice). */
export function detectVectorTileFormat(
  url: string,
  kind?: VectorTileFormat | 'auto',
): VectorTileFormat | null {
  const path = url.split('?')[0]
  if (path.endsWith('.tilejson')) return 'tilejson'
  if (path.endsWith('.json') && !path.endsWith('.geojson')) return 'tilejson'
  if (path.endsWith('.pmtiles')) return 'pmtiles'
  if (path.endsWith('.xgvt')) return 'xgvt'
  if (kind && kind !== 'auto') return kind
  return null
}

/** @deprecated Use {@link detectVectorTileFormat}. PMTiles is the
 *  legacy fallback for unknown URLs declared as a vector tile source,
 *  preserved for back-compat with `type: pmtiles` xgis declarations
 *  pointing at extensionless archives. */
export function resolveDispatch(
  url: string,
  kind: 'pmtiles' | 'tilejson' | 'auto' | undefined,
): 'pmtiles' | 'tilejson' {
  const f = detectVectorTileFormat(url, kind)
  return f === 'tilejson' ? 'tilejson' : 'pmtiles'
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
async function fetchTileWithRetry(url: string, tileLabel: string, signal: AbortSignal): Promise<Uint8Array | null | 'failed'> {
  // Already aborted before we even started — short-circuit. Surfaced
  // as AbortError to the catch block in PMTilesBackend.loadTile so
  // it skips the failedKeys negative cache.
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
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
      const resp = await fetch(url, { signal })
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
      // AbortError — propagate up, never retry, never negative-cache.
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      // Network error (DNS, TLS, etc.). Retryable.
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
    // Out of retries — fall through to graceful null.
    if (attempt === backoffsMs.length) break
    // Also bail out of backoff sleep if aborted in between attempts.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, backoffsMs[attempt])
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
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

// Skeleton prewarm + default depth moved to TileCatalog.prewarmSkeleton
// (data/tile-catalog.ts) so XGVT-binary, GeoJSON-runtime, and any
// future source type get the same Cesium replace-refinement anchor
// behaviour — single skeleton path across all backends.

/** Unified shape returned by `resolveSource`. PMTiles and TileJSON
 *  produce different metadata containers (header vs manifest) but the
 *  attach flow only needs the same six fields + a fetcher closure, so
 *  we collapse both into this struct and the attach body becomes
 *  format-agnostic. */
interface ResolvedSource {
  kind: 'pmtiles' | 'tilejson'
  name?: string
  attribution?: string
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
  vectorLayers: VectorLayerInfo[]
  /** Format-specific log fragment ("N tile entries" vs "template=..."). */
  logDetail: string
  fetcher: PMTilesFetcher
}

async function resolveSource(opts: PMTilesSourceOptions): Promise<ResolvedSource | null> {
  // XGVT was peeled off above; only PMTiles vs TileJSON remain. The
  // detector returns pmtiles for the unknown / extensionless case,
  // which preserves the legacy "type: pmtiles" fallback behaviour.
  const dispatch = detectVectorTileFormat(opts.url, opts.kind) === 'tilejson' ? 'tilejson' : 'pmtiles'
  if (dispatch === 'tilejson') {
    let tj: CachedTileJSON
    try { tj = await openCachedTileJSON(opts.url) }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      console.error(
        `[X-GIS] TileJSON attach failed for ${opts.url}\n` +
        `  ${msg}\n` +
        `  If this is "Failed to fetch", the manifest's origin lacks\n` +
        `  Access-Control-Allow-Origin for your origin. Use a host\n` +
        `  that allows your origin in its CORS settings.`,
      )
      return null
    }
    return {
      kind: 'tilejson',
      name: tj.name,
      attribution: tj.attribution,
      minZoom: tj.minzoom,
      maxZoom: tj.maxzoom,
      bounds: tj.bounds,
      vectorLayers: tj.vectorLayers,
      logDetail: `template=${tj.tilesTemplate}`,
      // XYZ template fetcher with retry + graceful fallback. fetch()
      // auto-decompresses gzip via Content-Encoding, so bytes are raw
      // MVT (same shape PMTilesBackend expects). 404 / 204 = missing
      // tile (final); 5xx + network errors retry with backoff then
      // null — see fetchTileWithRetry for recovery semantics.
      fetcher: async (z, x, y, signal) => {
        const url = tj.tilesTemplate
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
        return fetchTileWithRetry(url, `tile ${z}/${x}/${y}`, signal)
      },
    }
  }
  // PMTiles archive
  let cached: CachedArchive
  try { cached = await openCachedArchive(opts.url) }
  catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error(
      `[X-GIS] PMTiles attach failed for ${opts.url}\n` +
      `  ${msg}\n` +
      `  If this is "Failed to fetch", the archive's origin likely\n` +
      `  doesn't set Access-Control-Allow-Origin. Use a CORS-enabled\n` +
      `  host (e.g. pmtiles.io) or proxy the archive through your dev\n` +
      `  server (vite.config.ts proxy entry).`,
    )
    return null
  }
  const { archive, header } = cached
  return {
    kind: 'pmtiles',
    name: cached.archiveName,
    attribution: cached.attribution,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    vectorLayers: cached.vectorLayers,
    logDetail: `${header.numTileEntries} tile entries`,
    fetcher: async (z, x, y, signal) => {
      // Pre-flight abort check. The pmtiles library doesn't accept
      // an AbortSignal natively; we short-circuit before/after the
      // range request and throw AbortError so PMTilesBackend's catch
      // skips the failedKeys negative cache. We do NOT race the await
      // against the signal — pmtiles interleaves directory-page
      // fetches inside getZxy and bailing mid-flight leaves its
      // internal directory cache half-populated.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const resp = await archive.getZxy(z, x, y)
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return resp ? new Uint8Array(resp.data) : null
    },
  }
}

/** Attach a vector tile source (PMTiles archive, TileJSON manifest, or
 *  X-GIS native `.xgvt` binary) to an existing TileCatalog. Returns
 *  once the header / manifest is read (or the binary file finished
 *  loading); tiles are fetched on-demand from that point on. Format is
 *  auto-detected from the URL extension, or supply `opts.kind` to
 *  override. Skeleton prewarm fires automatically for all three
 *  formats — see `TileCatalog.prewarmSkeleton`. */
export async function attachPMTilesSource(
  source: TileCatalog,
  opts: PMTilesSourceOptions,
): Promise<void> {
  // ── XGVT-binary delegation ──
  // Native binary archive — no PMTilesBackend / no MVT decode. The
  // binary's own loader handles range-request streaming and the
  // catalog's `loadFromURL` auto-fires `prewarmSkeleton` once the
  // index is merged, so the cold-start UX matches PMTiles/TileJSON.
  if (detectVectorTileFormat(opts.url, opts.kind) === 'xgvt') {
    try { await source.loadFromURL(opts.url) }
    catch {
      const resp = await fetch(opts.url)
      const buf = await resp.arrayBuffer()
      await source.loadFromBuffer(buf)
    }
    return
  }

  const meta = await resolveSource(opts)
  if (!meta) return  // soft-fail: catalog stays empty, demo still loads

  // Unified log + layer-filter validation (was duplicated across the
  // PMTiles / TileJSON branches before this consolidation).
  const formatName = meta.kind === 'pmtiles' ? 'PMTiles' : 'TileJSON'
  const layerSummary = meta.vectorLayers.length > 0
    ? ` | layers: ${meta.vectorLayers.map(l => `${l.id}(z${l.minzoom}-${l.maxzoom})`).join(', ')}`
    : ''
  const boundsStr = meta.bounds.map(v => v.toFixed(4)).join(', ')
  console.log(
    `[X-GIS] ${formatName} attached${meta.name ? ` "${meta.name}"` : ''}: ` +
    `z=${meta.minZoom}..${meta.maxZoom}, bounds=[${boundsStr}], ` +
    `${meta.logDetail}${layerSummary}`,
  )
  if (meta.attribution) console.log(`[X-GIS] ${formatName} attribution: ${meta.attribution}`)
  if (opts.layers && meta.vectorLayers.length > 0) {
    const known = new Set(meta.vectorLayers.map(l => l.id))
    for (const lname of opts.layers) {
      if (!known.has(lname)) {
        console.warn(
          `[X-GIS] ${formatName}: requested layer "${lname}" is not in ` +
          `vector_layers. Known: [${meta.vectorLayers.map(l => l.id).join(', ')}].`,
        )
      }
    }
  }

  source.attachBackend(new PMTilesBackend({
    minZoom: meta.minZoom,
    maxZoom: meta.maxZoom,
    bounds: meta.bounds,
    layers: opts.layers,
    vectorLayers: meta.vectorLayers,
    extrudeExprs: opts.extrudeExprs,
    extrudeBaseExprs: opts.extrudeBaseExprs,
    showSlices: opts.showSlices,
    strokeWidthExprs: opts.strokeWidthExprs,
    strokeColorExprs: opts.strokeColorExprs,
    fetcher: meta.fetcher,
  }))
  source.prewarmSkeleton({
    depth: opts.prewarmSkeletonDepth,
    minzoom: meta.minZoom,
    maxzoom: meta.maxZoom,
  })
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

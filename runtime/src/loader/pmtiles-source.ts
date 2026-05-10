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

/** Prewarm the archive cache for `url`. Fire-and-forget — any
 *  attach call later in the same session reuses the cached header +
 *  metadata instead of re-issuing the two sequential HTTP round trips
 *  (header → metadata). Call this as early as URLs become known
 *  (after IR emit) so the network round trips overlap with shader
 *  pipeline compilation, GPU adapter init, etc.
 *
 *  Errors are swallowed — a bad URL or transient network issue should
 *  fall through to the regular attach path which will retry and surface
 *  the error there. */
export function prewarmPMTilesArchive(url: string): void {
  if (archiveCache.has(url)) return
  // openCachedArchive is module-private; call it through a tiny
  // wrapper that swallows the rejection so unhandled-promise listeners
  // don't fire. The real attach path awaits the same promise and
  // surfaces the error normally.
  void openCachedArchive(url).catch(() => undefined)
}

/** Prewarm the TileJSON manifest cache. Companion to
 *  {@link prewarmPMTilesArchive} for the TileJSON branch — manifest
 *  fetches are a single round trip but still 50-200 ms that the
 *  attach path used to await sequentially. Same cache hits the regular
 *  attach path's `openCachedTileJSON` later. */
export function prewarmTileJSONManifest(url: string): void {
  if (tileJsonCache.has(url)) return
  void openCachedTileJSON(url).catch(() => undefined)
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
  /** Explicit declaration of what's at the URL. Lets the caller
   *  override the URL-extension heuristic when the manifest URL has
   *  no recognizable suffix (e.g. `https://tiles.example.com/planet`
   *  is a TileJSON manifest but doesn't end with `.json`). Defaults
   *  to `'auto'` (sniff by URL). */
  kind?: 'pmtiles' | 'tilejson' | 'auto'
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

/** Decide whether `attachPMTilesSource` should take its TileJSON
 *  branch or its PMTiles-archive branch. Routing precedence
 *  (most-authoritative first):
 *
 *    1. URL extension says JSON       → 'tilejson', period.
 *       The server is the source of truth for what bytes come
 *       back; an explicit `kind: pmtiles` from a stale xgis
 *       source can't change that. Without this, the protomaps
 *       production rewrite (.pmtiles → api.protomaps.com/v4.json
 *       ?key=…) tried to read the TileJSON response as a PMTiles
 *       archive header and failed with "Wrong magic number".
 *    2. URL extension says .pmtiles   → 'pmtiles', period.
 *    3. Otherwise honour explicit `kind` ('pmtiles' | 'tilejson').
 *    4. Fall back to PMTiles for the unknown / extensionless case
 *       — that's the legacy default (`type: pmtiles` xgis sources
 *       with cleanly-named .pmtiles archives).
 *
 *  Exported so the dispatch decision is unit-testable in isolation. */
export function resolveDispatch(
  url: string,
  kind: 'pmtiles' | 'tilejson' | 'auto' | undefined,
): 'pmtiles' | 'tilejson' {
  const urlSaysTileJSON = looksLikeTileJSON(url)
  if (urlSaysTileJSON) return 'tilejson'
  const urlSaysPMTiles = /\.pmtiles(\?|$)/.test(url.split('?')[0])
  if (urlSaysPMTiles) return 'pmtiles'
  if (kind === 'tilejson') return 'tilejson'
  return 'pmtiles'
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

/** Viewport-aware default skeleton depth. Mobile gets a tighter
 *  depth=2 (1+4+16 = 21 tiles, ~1 MB) — same `innerWidth ≤ 900`
 *  threshold as `maxConcurrentLoads()` / `maxCachedBytes()` so the
 *  three caps stay coherent. Desktop gets depth=3 (85 tiles, ~4 MB),
 *  enough that fast-pan to any city on the globe finds a cached
 *  ancestor within ≤ 3 walk hops at typical view zoom (z≈14). Lazy
 *  function form for the same reason as the other caps — module-init
 *  evaluation captures the wrong viewport in Playwright / mobile DPR
 *  setup. */
function defaultSkeletonDepth(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? 2 : 3
}

/** Pre-fetch and pin the global z=`sourceMinzoom`..`min(depth,
 *  sourceMaxzoom)` quadtree skeleton on `source`. Fire-and-forget;
 *  caller awaits attach without waiting for the skeleton. Mirrors
 *  Cesium `QuadtreePrimitive` permanent-root retention so
 *  `classifyFallback`'s ancestor walk always finds a cached tile
 *  even on fast-pan to a brand-new region. The pin survives both
 *  byte-cap eviction (`evictTiles` filter) and backend-fetch
 *  cancellation (`cancelStale` merged set) — see `markSkeleton`
 *  doc in tile-catalog.ts.
 *
 *  Pump rationale: `TileCatalog.requestTiles` breaks at
 *  `maxConcurrentLoads()` and silently drops the rest of the keys
 *  (next-frame visible-tile fetches re-trigger via VTR, but the
 *  skeleton is never in any visible set so nothing else re-issues
 *  it). The 250 ms retry covers the gap until each wave drains.
 *  Distance-from-camera ordering inside `PMTilesBackend.fetchQueue`
 *  picks up the natural top-down order for free, so no level-by-level
 *  scheduling is needed — single bulk + retry suffices. */
function enqueueSkeletonPrewarm(
  source: TileCatalog,
  depth: number,
  sourceMinzoom: number,
  sourceMaxzoom: number,
): void {
  if (depth < 0) return
  const cap = Math.min(depth, sourceMaxzoom)
  const start = Math.max(0, sourceMinzoom)
  if (cap < start) return
  const keys: number[] = []
  for (let z = start; z <= cap; z++) {
    const n = 1 << z
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        keys.push(tileKey(z, x, y))
      }
    }
  }
  // Mark BEFORE the first prefetch — guarantees protection even if
  // an evictTiles / cancelStale fires between enqueue and the first
  // bytes arriving.
  source.markSkeleton(keys)
  const tick = (): void => {
    const remaining = keys.filter(k => !source.hasTileData(k))
    if (remaining.length === 0) return
    source.prefetchTiles(remaining)
    setTimeout(tick, 250)
  }
  tick()
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
  if (resolveDispatch(opts.url, opts.kind) === 'tilejson') {
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
      extrudeExprs: opts.extrudeExprs,
      extrudeBaseExprs: opts.extrudeBaseExprs,
      showSlices: opts.showSlices,
      strokeWidthExprs: opts.strokeWidthExprs,
    strokeColorExprs: opts.strokeColorExprs,
      // XYZ template fetcher with retry + graceful fallback.
      // `fetch()` auto-decompresses gzip via Content-Encoding, so the
      // bytes are raw MVT (same shape PMTilesBackend expects from the
      // archive path). 404 / 204 = missing tile (final). 5xx + network
      // errors → retry with backoff (300ms, 900ms), then null — see
      // fetchTileWithRetry above for the recovery semantics.
      fetcher: async (z, x, y, signal) => {
        const url = tj.tilesTemplate
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
        return fetchTileWithRetry(url, `tile ${z}/${x}/${y}`, signal)
      },
    }))
    enqueueSkeletonPrewarm(
      source,
      opts.prewarmSkeletonDepth ?? defaultSkeletonDepth(),
      tj.minzoom,
      tj.maxzoom,
    )
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
    extrudeExprs: opts.extrudeExprs,
    extrudeBaseExprs: opts.extrudeBaseExprs,
    showSlices: opts.showSlices,
    fetcher: async (z, x, y, signal) => {
      // Pre-flight abort check. The pmtiles library doesn't natively
      // accept an AbortSignal; we can't kill the underlying HTTP
      // range request in flight, but we can short-circuit before it
      // starts AND discard the result on resolve if the catalog
      // cancelled in the meantime. Throwing AbortError here lets
      // PMTilesBackend.loadTile's catch path skip the failedKeys
      // negative cache (abort isn't a real fetch error). We do NOT
      // race the await against the signal — the pmtiles archive
      // implementation interleaves directory-page fetches inside
      // getZxy, and bailing early would leave the archive's internal
      // directory cache half-populated, blocking subsequent loads.
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      const resp = await archive.getZxy(z, x, y)
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      return resp ? new Uint8Array(resp.data) : null
    },
  }))
  enqueueSkeletonPrewarm(
    source,
    opts.prewarmSkeletonDepth ?? defaultSkeletonDepth(),
    header.minZoom,
    header.maxZoom,
  )
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

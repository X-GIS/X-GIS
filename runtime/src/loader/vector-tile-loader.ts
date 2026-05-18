// Class-based vector tile loader.
//
// Architecture:
//   VectorTileLoader      — orchestrator. Owns archive + manifest caches,
//                           dispatches to a VectorTileSource by URL/kind,
//                           hosts attach + prewarm + fetchVectorLayerSchema.
//   VectorTileSource      — abstract base. Subclasses encapsulate format-
//                           specific resolution + attach behaviour. The
//                           base provides the unified attach flow (log →
//                           validate layers → attachBackend(PMTilesBackend)
//                           → prewarmSkeleton) reused by every PMTiles-
//                           backend-backed source.
//   PMTilesArchiveSource  — `.pmtiles` archive, byte-range streamed.
//   TileJSONSource        — TileJSON manifest pointing at an XYZ MVT server.
//   XGVTBinarySource      — native binary; overrides attachTo to delegate
//                           to TileCatalog.loadFromURL (no PMTilesBackend).
//
// Public API: a default singleton VectorTileLoader instance + thin function
// wrappers (`attachPMTilesSource`, `loadPMTilesSource`, `prewarmVectorTileSource`,
// `fetchPMTilesVectorLayerSchema`, `fetchPMTilesVectorLayerFields`,
// `clearPMTilesArchiveCache`, `detectVectorTileFormat`, `resolveDispatch`)
// preserve every prior import path. Power users can construct their own
// loader instance for isolated caches.

import { PMTiles, TileType, type Header } from 'pmtiles'
import { TileCatalog } from '../data/tile-catalog'
import { PMTilesBackend, type PMTilesFetcher } from '../data/sources/pmtiles-backend'

// ─── Types ──────────────────────────────────────────────────────────

/** Per-MVT-layer info pulled from `metadata.vector_layers`. Used by
 *  the runtime to skip work when the current camera zoom is outside a
 *  layer's data range — protomaps v4 only carries `roads` at z≥6 and
 *  `buildings` at z≥14, so requesting them at z=0/z=3 would otherwise
 *  trigger FLICKER warnings + sub-tile generation for tiles the archive
 *  simply doesn't have features in. */
export interface VectorLayerInfo {
  id: string
  minzoom: number
  maxzoom: number
  fields?: Record<string, string>
}

/** The vector tile formats this loader knows how to attach. `null`
 *  means "the URL doesn't look like any of these" — the caller (e.g.
 *  the data-load loop in map.ts) routes to a different branch (raster,
 *  GeoJSON, etc.). */
export type VectorTileFormat = 'pmtiles' | 'tilejson'

export interface PMTilesSourceOptions {
  url: string
  /** Explicit declaration of what's at the URL. Bypasses URL-extension
   *  sniffing when the caller already knows the format (`.pmtiles` is
   *  unambiguous; `.json` could be TileJSON or GeoJSON; manifest URLs
   *  often have no extension at all). Default `'auto'`.
   *
   *  - `'pmtiles'` — single .pmtiles archive, byte-range MVT.
   *  - `'tilejson'` — TileJSON manifest pointing at an XYZ MVT server.
   *  - `'auto'` — sniff by URL extension. */
  kind?: VectorTileFormat | 'auto'
  /** Restrict to a subset of MVT layer names (default: all layers). */
  layers?: string[]
  /** Per-MVT-layer 3D-extrude expression AST. */
  extrudeExprs?: Record<string, unknown>
  /** Per-MVT-layer 3D-extrude BASE expression AST. */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null }>
  /** Per-sliceKey stroke-width override AST. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. */
  strokeColorExprs?: Record<string, unknown>
  /** Skeleton prewarm depth — see TileCatalog.prewarmSkeleton. */
  prewarmSkeletonDepth?: number
}

/** Unified shape returned by `VectorTileSource.resolve()` for sources
 *  that go through `PMTilesBackend`. PMTiles and TileJSON produce
 *  different metadata containers (header vs manifest) but the attach
 *  flow only needs the same six fields + a fetcher closure. XGVT-
 *  binary sources don't go through PMTilesBackend and return null. */
export interface ResolvedSource {
  format: VectorTileFormat
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

interface CachedArchive {
  archive: PMTiles
  header: Header
  vectorLayers: VectorLayerInfo[]
  archiveName?: string
  attribution?: string
}

interface CachedTileJSON {
  tilesTemplate: string
  bounds: [number, number, number, number]
  minzoom: number
  maxzoom: number
  vectorLayers: VectorLayerInfo[]
  name?: string
  attribution?: string
}

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

// ─── Format detection ───────────────────────────────────────────────

/** Single source of truth for "what format is at `url`". Used by the
 *  data-load loop to decide if a load is a vector tile source at all,
 *  by `VectorTileLoader.sourceFor` to pick which subclass to instantiate,
 *  and by `prewarm` to pick which cache to prime.
 *
 *  Routing precedence (most-authoritative first):
 *    1. URL extension is decisive when present (`.tilejson` / `.json`,
 *       `.pmtiles`, `.xgvt`). The server is the source of truth for
 *       what bytes come back — an explicit `kind: pmtiles` from a stale
 *       xgis source can't override a `.json` URL (that broke the
 *       protomaps `.pmtiles → api.protomaps.com/v4.json?key=…` rewrite
 *       with "Wrong magic number" before the URL-wins rule landed).
 *       `.geojson` is excluded so feature-data URLs aren't mis-routed.
 *    2. Otherwise honour explicit `kind`.
 *    3. Fall through to `null` — caller decides what to do with the
 *       unknown URL. */
export function detectVectorTileFormat(
  url: string,
  kind?: VectorTileFormat | 'auto',
): VectorTileFormat | null {
  // Strip BOTH query (?…) and fragment (#…) before extension matching.
  // Pre-fix only `?` was split off, so a URL like 'x.pmtiles#frag'
  // kept '#frag' in the path → endsWith('.pmtiles') failed → fell to
  // null and the caller defaulted to PMTiles which crashed on the
  // wrong-magic-number boundary. Mirror of the compiler-side fragment
  // detection fix (8885924).
  // Strip the Protomaps `pmtiles://` scheme prefix if a host passed
  // it through bypassing the converter side. Mirror of the compiler
  // strip (3b81145). The protomaps/PMTiles library expects a bare
  // URL; without the strip the format detection still routed pmtiles
  // (since the inner URL ends with .pmtiles) but the subsequent
  // fetch failed on the `pmtiles:` scheme.
  // Case-insensitive scheme strip per RFC 3986 §3.1 — `PMTILES://...`
  // is the same URI as `pmtiles://...`. Path extension matching is
  // ALSO case-insensitive so `.PMTILES` / `.JSON` / `.TILEJSON` from a
  // case-tolerant server (Windows-style or S3 keys uppercased by an
  // upstream rewrite) route correctly instead of falling to the null
  // return + PMTiles-default crash on Wrong magic number.
  const stripped = /^pmtiles:\/\//i.test(url) ? url.slice('pmtiles://'.length) : url
  const path = stripped.split('?')[0]!.split('#')[0]!
  const lcPath = path.toLowerCase()
  if (lcPath.endsWith('.tilejson')) return 'tilejson'
  if (lcPath.endsWith('.json') && !lcPath.endsWith('.geojson')) return 'tilejson'
  if (lcPath.endsWith('.pmtiles')) return 'pmtiles'
  // Mapbox-style vector sources can declare `tiles: ["…/{z}/{x}/{y}.mvt"]`
  // (single-tile XYZ endpoint, no TileJSON manifest). Route those into
  // the MVT path; the loader synthesises a minimal TileJSON wrapper
  // around the template so the rest of the vector-tile pipeline doesn't
  // need to know whether the source had a real manifest or not.
  // ALSO accept extensionless `{z}/{x}/{y}` URLs — some Mapbox styles
  // (and OSM-derived hosts) author the XYZ template without a file
  // extension. The presence of all three placeholders is a strong
  // signal the URL is a per-tile fetch template, not a manifest. Pre-
  // fix this case fell to the `null` return and the caller defaulted
  // to PMTiles, which then failed with "Wrong magic number" on the
  // first fetch.
  if (kind === 'auto' || kind === 'tilejson') {
    if (lcPath.endsWith('.mvt') || lcPath.endsWith('.pbf')) return 'tilejson'
    if (url.includes('{z}') && url.includes('{x}') && url.includes('{y}')) {
      return 'tilejson'
    }
  }
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

// ─── Cache helpers ──────────────────────────────────────────────────

/** Memoize an in-flight fetch by URL: dedupes concurrent callers, evicts
 *  on rejection so the next call retries instead of resolving the cached
 *  failure forever. */
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

/** Normalize a TileJSON / PMTiles `vector_layers[]` entry. Both formats
 *  use the same shape but different default-zoom plumbing, so the per-
 *  layer minzoom/maxzoom fall back to the SOURCE's overall zoom range
 *  when a layer omits them. */
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

// ─── Per-tile fetch retry (module-level, shared globally) ───────────

/** Per-URL "last error logged at" timestamp (ms). Throttles transient
 *  5xx logs to once per minute per URL pattern instead of flooding the
 *  console — important when 100+ tiles share an upstream blip. */
const tileFetchLogThrottle = new Map<string, number>()
const TILE_FETCH_LOG_INTERVAL_MS = 60_000

/** Negative cache for individual tile URLs that exhausted retry. The
 *  TTL covers short-to-medium outages while still giving the upstream
 *  a chance to recover without a page reload. */
const tileFetchNegativeCache = new Map<string, number>()
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000

/** Single-tile fetch with retry + graceful null fallback for transient
 *  upstream failures (5xx, network errors). Returns:
 *
 *  - `Uint8Array` — successful fetch (200/206 with bytes)
 *  - `null`        — tile is missing (404 / 204)
 *  - `'failed'`    — exhausted retries on a transient error; the catalog
 *                    keeps the tile in failedKeys so the parent-walk falls
 *                    back to the nearest cached ancestor.
 *
 *  Backoff: 300 ms, then 900 ms (max 2 retries → 3 attempts total). */
async function fetchTileWithRetry(
  url: string, tileLabel: string, signal: AbortSignal,
): Promise<Uint8Array | null | 'failed'> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  // Defensive: empty URL would hit the current document URL via
  // fetch(""). The host's HTML (200 OK) would arrive as supposed
  // tile data and the MVT parser would crash on the response bytes.
  // Compiler now rejects empty URLs upstream (iter 300); this gate
  // catches hand-constructed scenes that bypass the converter.
  if (!url || typeof url !== 'string') return 'failed'
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
      if (resp.status === 404 || resp.status === 204) return null
      if (resp.ok) {
        const buf = await resp.arrayBuffer()
        return new Uint8Array(buf)
      }
      lastErr = new Error(`${tileLabel}: HTTP ${resp.status}`)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
    if (attempt === backoffsMs.length) break
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, backoffsMs[attempt])
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }
  tileFetchNegativeCache.set(url, Date.now() + NEGATIVE_CACHE_TTL_MS)
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

// ─── Source classes ────────────────────────────────────────────────

/** Abstract base for every vector tile format. Subclasses implement
 *  format-specific resolution; the base supplies the common attach
 *  flow (log → validate layers → attachBackend → prewarmSkeleton) used
 *  by every source backed by `PMTilesBackend`. */
export abstract class VectorTileSource {
  abstract readonly format: VectorTileFormat

  constructor(public readonly url: string) {}

  /** Fetch metadata + build a fetcher closure. Sources that don't go
   *  through `PMTilesBackend` (e.g. XGVT-binary) return null and override
   *  `attachTo`. Returns null on a soft failure (e.g. CORS). */
  abstract resolve(): Promise<ResolvedSource | null>

  /** HTTP-level metadata prefetch. Default no-op; subclasses with their
   *  own cache override. */
  prewarm(): void {}

  /** Default attach flow for sources resolved into a `ResolvedSource`.
   *  Polymorphic — XGVT-binary overrides since it bypasses PMTilesBackend. */
  async attachTo(catalog: TileCatalog, opts: PMTilesSourceOptions): Promise<void> {
    const meta = await this.resolve()
    if (!meta) return  // soft-fail: catalog stays empty, demo still loads

    const formatName = meta.format === 'pmtiles' ? 'PMTiles' : 'TileJSON'
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

    catalog.attachBackend(new PMTilesBackend({
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
    catalog.prewarmSkeleton({
      depth: opts.prewarmSkeletonDepth,
      minzoom: meta.minZoom,
      maxzoom: meta.maxZoom,
    })
  }
}

export class PMTilesArchiveSource extends VectorTileSource {
  readonly format = 'pmtiles' as const

  constructor(url: string, private readonly loader: VectorTileLoader) {
    super(url)
  }

  async resolve(): Promise<ResolvedSource | null> {
    let cached: CachedArchive
    try { cached = await this.loader.openArchive(this.url) }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      console.error(
        `[X-GIS] PMTiles attach failed for ${this.url}\n` +
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
      format: 'pmtiles',
      name: cached.archiveName,
      attribution: cached.attribution,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      vectorLayers: cached.vectorLayers,
      logDetail: `${header.numTileEntries} tile entries`,
      fetcher: async (z, x, y, signal) => {
        // Pre-flight abort check. The pmtiles library doesn't accept an
        // AbortSignal natively; we short-circuit before/after the range
        // request and throw AbortError so PMTilesBackend's catch skips
        // the failedKeys negative cache. We do NOT race the await
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

  prewarm(): void {
    void this.loader.openArchive(this.url).catch(() => undefined)
  }
}

export class TileJSONSource extends VectorTileSource {
  readonly format = 'tilejson' as const

  constructor(url: string, private readonly loader: VectorTileLoader) {
    super(url)
  }

  async resolve(): Promise<ResolvedSource | null> {
    let tj: CachedTileJSON
    try { tj = await this.loader.openTileJSON(this.url) }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      console.error(
        `[X-GIS] TileJSON attach failed for ${this.url}\n` +
        `  ${msg}\n` +
        `  If this is "Failed to fetch", the manifest's origin lacks\n` +
        `  Access-Control-Allow-Origin for your origin. Use a host\n` +
        `  that allows your origin in its CORS settings.`,
      )
      return null
    }
    return {
      format: 'tilejson',
      name: tj.name,
      attribution: tj.attribution,
      minZoom: tj.minzoom,
      maxZoom: tj.maxzoom,
      bounds: tj.bounds,
      vectorLayers: tj.vectorLayers,
      logDetail: `template=${tj.tilesTemplate}`,
      // XYZ template fetcher with retry + graceful fallback. fetch()
      // auto-decompresses gzip via Content-Encoding, so bytes are raw
      // MVT (same shape PMTilesBackend expects).
      fetcher: async (z, x, y, signal) => {
        // Global replace so URL templates with multiple occurrences
        // of {z}/{x}/{y} substitute correctly. Pre-fix single-pass
        // .replace only replaced the FIRST occurrence; a URL like
        // "https://example.com/{z}/{x}/{y}/{z}-{x}.mvt" left the
        // second {z} and {x} intact and the fetch 400'd on the
        // unsubstituted placeholders.
        const url = tj.tilesTemplate
          .replace(/\{z\}/g, String(z))
          .replace(/\{x\}/g, String(x))
          .replace(/\{y\}/g, String(y))
          // Mapbox spec `{ratio}` placeholder = DPR suffix
          // (`""` for 1x, `"@2x"` for 2x). X-GIS doesn't switch
          // per DPR yet so we substitute the empty 1x form;
          // pre-fix the unsubstituted literal `{ratio}` reached
          // fetch and 404'd. Compiler also warns at convert time
          // (iter 302) so the user sees the partial support.
          .replace(/\{ratio\}/g, '')
        return fetchTileWithRetry(url, `tile ${z}/${x}/${y}`, signal)
      },
    }
  }

  prewarm(): void {
    void this.loader.openTileJSON(this.url).catch(() => undefined)
  }
}

// ─── Loader ────────────────────────────────────────────────────────

/** Owns the archive + manifest caches and dispatches URLs to the right
 *  `VectorTileSource` subclass. The default singleton (`defaultLoader`
 *  below) backs the public function-style API; instantiate your own
 *  loader for tests that need an isolated cache. */
export class VectorTileLoader {
  private readonly archiveCache = new Map<string, Promise<CachedArchive>>()
  private readonly tileJsonCache = new Map<string, Promise<CachedTileJSON>>()

  /** Construct a `VectorTileSource` for `url` (or `null` if the URL
   *  doesn't look like any vector tile format we know). */
  sourceFor(url: string, kind?: VectorTileFormat | 'auto'): VectorTileSource | null {
    switch (detectVectorTileFormat(url, kind)) {
      case 'pmtiles':  return new PMTilesArchiveSource(url, this)
      case 'tilejson': return new TileJSONSource(url, this)
      default:         return null
    }
  }

  /** Attach a vector tile source to `catalog`. Auto-detects format by
   *  URL extension, or override via `opts.kind`. Skeleton prewarm fires
   *  automatically for every format. */
  async attach(catalog: TileCatalog, opts: PMTilesSourceOptions): Promise<void> {
    const src = this.sourceFor(opts.url, opts.kind)
    if (!src) return
    await src.attachTo(catalog, opts)
  }

  /** Convenience: spin up a fresh `TileCatalog` and attach `opts` to it. */
  async load(opts: PMTilesSourceOptions): Promise<TileCatalog> {
    const catalog = new TileCatalog()
    await this.attach(catalog, opts)
    return catalog
  }

  /** HTTP-level cache prefetch — call as soon as URLs become known
   *  (after IR emit) so the network round trips overlap with shader
   *  pipeline compilation, GPU adapter init, etc. */
  prewarm(url: string, kind?: VectorTileFormat | 'auto'): void {
    this.sourceFor(url, kind)?.prewarm()
  }

  /** Per-source-layer field schema from PMTiles metadata. Returns null
   *  when the archive has no vector_layers metadata or the fetch fails. */
  async fetchVectorLayerSchema(url: string): Promise<Record<string, Record<string, string>> | null> {
    try {
      const cached = await this.openArchive(url)
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

  /** Flat union of `vector_layers[*].fields`. Back-compat shim around
   *  `fetchVectorLayerSchema` for callers that don't need per-source-
   *  layer scoping. */
  async fetchVectorLayerFields(url: string): Promise<Record<string, string> | null> {
    const schema = await this.fetchVectorLayerSchema(url)
    if (!schema) return null
    const merged: Record<string, string> = {}
    for (const fields of Object.values(schema)) {
      for (const [k, v] of Object.entries(fields)) merged[k] = v
    }
    return Object.keys(merged).length > 0 ? merged : null
  }

  /** Test/dev hook — drop both caches (force re-fetch in unit tests or
   *  after a known-stale archive update). */
  clearCache(): void {
    this.archiveCache.clear()
    this.tileJsonCache.clear()
  }

  // ─── Internal — used by VectorTileSource subclasses ────────────────

  /** Open a PMTiles archive (or return a cached open one). Caches by
   *  URL. Drops the cache entry on failure so the next call retries. */
  openArchive(url: string): Promise<CachedArchive> {
    // Strip Protomaps `pmtiles://` prefix before the PMTiles library
    // sees it. Mirror of the detectVectorTileFormat strip (a5fd65a).
    // Without this the library calls fetch on the prefixed URL and
    // the request fails on the made-up scheme. Memoise key uses the
    // stripped form so callers that pass either shape hit the same
    // cache entry.
    // Case-insensitive per RFC 3986 §3.1 — mirror of the
    // detectVectorTileFormat strip and compiler-side stripPmtilesScheme.
    const cleanUrl = /^pmtiles:\/\//i.test(url) ? url.slice('pmtiles://'.length) : url
    return memoizeOpen(this.archiveCache, cleanUrl, async () => {
      const archive = new PMTiles(cleanUrl)
      const header = await archive.getHeader()
      if (header.tileType !== TileType.Mvt) {
        throw new Error(`[vector-tile-loader] tileType ${header.tileType} not supported — only MVT (1)`)
      }
      let vectorLayers: VectorLayerInfo[] = []
      let archiveName: string | undefined
      let attribution: string | undefined
      try {
        const meta = await archive.getMetadata() as {
          name?: string
          attribution?: string
          vector_layers?: Array<{ id: string; minzoom?: number; maxzoom?: number; fields?: Record<string, string> }>
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

  /** Open and parse a TileJSON manifest (or return a cached one). */
  openTileJSON(url: string): Promise<CachedTileJSON> {
    return memoizeOpen(this.tileJsonCache, url, async () => {
      // Mapbox-style sources can carry `tiles: ["…/{z}/{x}/{y}.mvt"]`
      // inline — no TileJSON manifest exists, the template IS the source.
      // Detect by the presence of XYZ placeholders and synthesize a
      // minimal manifest in-memory rather than fetching the template
      // URL as JSON (which would 404 or return MVT bytes for tile 0/0/0
      // depending on the server). Caller passes the template directly.
      if (url.includes('{z}') && url.includes('{x}') && url.includes('{y}')) {
        return {
          tilesTemplate: url,
          bounds: [-180, -85.0511287, 180, 85.0511287],
          minzoom: 0,
          maxzoom: 14,
          // No vector-layers metadata available without a manifest. The
          // runtime path that needs per-source-layer field schemas
          // (paint-shape data-driven evaluation) falls back to inferring
          // from MVT tile contents on the fly.
          vectorLayers: [],
          name: undefined,
          attribution: undefined,
        }
      }
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
}

// ─── Default singleton + back-compat function API ──────────────────

/** Process-wide loader instance. Backs every public function-style
 *  export below; share so concurrent attaches dedupe at the cache level. */
const defaultLoader = new VectorTileLoader()

export function attachPMTilesSource(
  source: TileCatalog, opts: PMTilesSourceOptions,
): Promise<void> {
  return defaultLoader.attach(source, opts)
}

export function loadPMTilesSource(opts: PMTilesSourceOptions): Promise<TileCatalog> {
  return defaultLoader.load(opts)
}

export function prewarmVectorTileSource(
  url: string, kind?: VectorTileFormat | 'auto',
): void {
  defaultLoader.prewarm(url, kind)
}

export function fetchPMTilesVectorLayerSchema(url: string): Promise<Record<string, Record<string, string>> | null> {
  return defaultLoader.fetchVectorLayerSchema(url)
}

export function fetchPMTilesVectorLayerFields(url: string): Promise<Record<string, string> | null> {
  return defaultLoader.fetchVectorLayerFields(url)
}

export function clearPMTilesArchiveCache(): void {
  defaultLoader.clearCache()
}

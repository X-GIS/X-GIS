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
 *  tests or after a known-stale archive update). */
export function clearPMTilesArchiveCache(): void {
  archiveCache.clear()
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

/** Attach a PMTiles archive to an existing TileCatalog as a lazy
 *  virtual catalog. Returns once the header is read; tiles are
 *  fetched on-demand from that point on. */
export async function attachPMTilesSource(
  source: TileCatalog,
  opts: PMTilesSourceOptions,
): Promise<void> {
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

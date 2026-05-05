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
import { PMTiles, TileType } from 'pmtiles'
import {
  decodeMvtTile, decomposeFeatures, compileSingleTile,
} from '@xgis/compiler'
import { TileCatalog } from '../data/tile-catalog'

export interface PMTilesSourceOptions {
  url: string
  /** Restrict to a subset of MVT layer names (default: all layers). */
  layers?: string[]
}

/** Attach a PMTiles archive to an existing TileCatalog as a lazy
 *  virtual catalog. Returns once the header is read; tiles are
 *  fetched on-demand from that point on. */
export async function attachPMTilesSource(
  source: TileCatalog,
  opts: PMTilesSourceOptions,
): Promise<void> {
  const archive = new PMTiles(opts.url)
  let header
  try {
    header = await archive.getHeader()
  } catch (e) {
    // Surface a user-actionable diagnosis instead of letting the raw
    // "TypeError: Failed to fetch" propagate up through the loader and
    // hang the demo. The single most common cause of header-fetch
    // failure is missing CORS headers on the archive's host (e.g.,
    // demo-bucket.protomaps.com does not set Access-Control-Allow-Origin).
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
  if (header.tileType !== TileType.Mvt) {
    throw new Error(
      `[pmtiles-source] tileType ${header.tileType} not supported — only MVT (1)`,
    )
  }
  console.log(
    `[X-GIS] PMTiles attached: z=${header.minZoom}..${header.maxZoom}, ` +
    `bounds=[${header.minLon.toFixed(4)}, ${header.minLat.toFixed(4)}, ` +
    `${header.maxLon.toFixed(4)}, ${header.maxLat.toFixed(4)}], ` +
    `${header.numTileEntries} tile entries`,
  )
  source.setVirtualCatalog({
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    fetcher: async (z, x, y) => {
      const resp = await archive.getZxy(z, x, y)
      if (!resp) {
        console.debug(`[pmtiles] miss z=${z}/${x}/${y}`)
        return null
      }
      const features = decodeMvtTile(resp.data, z, x, y, { layers: opts.layers })
      if (features.length === 0) {
        console.debug(`[pmtiles] empty z=${z}/${x}/${y}`)
        return null
      }
      const parts = decomposeFeatures(features)
      const tile = compileSingleTile(parts, z, x, y, header.maxZoom)
      if (!tile) {
        console.debug(`[pmtiles] compile-null z=${z}/${x}/${y}`)
      }
      return tile
    },
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

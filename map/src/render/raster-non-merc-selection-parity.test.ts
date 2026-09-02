// #2302: the raster/hillshade flat non-Mercator tile selection culled tile corners in
// MERCATOR-metre space (`visibleTilesFrustum` never calls `projection.forward` — it only reads
// `projection.name` for the world-copy count) while `vs_tile` draws the very same tiles through
// the DISPLAY projection (shaders/dsl/raster.ts) on the same MVP. At latitude, Mercator's
// vertical scale diverges sharply from equirect's (2× at 60°N), so tiles the shader placed
// inside the viewport were culled by the selector and never requested nor drawn — a blank band
// at the poleward viewport edge. `selectFlatProjTiles` (raster-renderer.ts) is now the single
// selection authority both renderers call; this test drives it directly and cross-checks its
// output against an independent reconstruction of what `vs_tile` actually draws on screen.

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from '@xgis/data'
import { getProjection, mercatorYToLat } from '@xgis/geo'
import { Camera, rasterCoverZoom, selectFlatProjTiles } from '@xgis/map'

const W = 1024
const H = 768
const DPR = 1
const LAT = 60
const PROJ_TYPE = 1 // equirectangular

function tileLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
}

/** Tiles at z=ZOOM whose equirect-projected footprint (the quad vs_tile rasterises, through the
 *  raster draw's own MVP) overlaps the viewport. Independent of `selectFlatProjTiles` — this is
 *  the drawn-side oracle the selector must agree with. */
function drawnTiles(camera: Camera, zoom: number): Map<string, string> {
  const proj = getProjection('equirectangular', 0, LAT)
  const camLat = Math.max(-85, Math.min(85, mercatorYToLat(camera.centerY)))
  const center = proj.forward(0, camLat)
  const mvp = Float32Array.from(camera.getViewForProjection(PROJ_TYPE, W, H, DPR).matrix)
  const toScreen = (lon: number, lat: number): [number, number] | null => {
    const p = proj.forward(lon, lat)
    const rx = p[0] - center[0]
    const ry = p[1] - center[1]
    const cw = mvp[3] * rx + mvp[7] * ry + mvp[15]
    if (cw <= 1e-6) return null
    const cx = mvp[0] * rx + mvp[4] * ry + mvp[12]
    const cy = mvp[1] * rx + mvp[5] * ry + mvp[13]
    return [(cx / cw + 1) * 0.5 * W, (1 - cy / cw) * 0.5 * H]
  }
  const n = 1 << zoom
  const out = new Map<string, string>()
  for (let y = 0; y < n; y++) {
    const latN = tileLat(y, n)
    const latS = tileLat(y + 1, n)
    if (latN < LAT - 5 || latS > LAT + 5) continue
    for (let x = n / 2 - 8; x < n / 2 + 8; x++) {
      const lonW = (x / n) * 360 - 180
      const lonE = ((x + 1) / n) * 360 - 180
      const c = [
        toScreen(lonW, latS),
        toScreen(lonE, latS),
        toScreen(lonE, latN),
        toScreen(lonW, latN),
      ]
      if (c.some((p) => p === null)) continue
      const xs = c.map((p) => p![0])
      const ys = c.map((p) => p![1])
      const overlaps =
        Math.max(...xs) >= 0 && Math.min(...xs) <= W && Math.max(...ys) >= 0 && Math.min(...ys) <= H
      if (!overlaps) continue
      out.set(
        `${zoom}/${x}/${y}`,
        `lat ${latS.toFixed(2)}..${latN.toFixed(2)} screenY ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`,
      )
    }
  }
  return out
}

describe('raster/hillshade flat non-Mercator tile selection vs the equirect draw (#2302)', () => {
  for (const zoom of [8, 10]) {
    it(`z${zoom} @ 60°N: every tile vs_tile draws on screen is selected (and requested)`, () => {
      const camera = new Camera(0, LAT, zoom)
      camera.projType = PROJ_TYPE

      const currentZ = rasterCoverZoom(zoom, 256)
      // The production selector both RasterRenderer.render and HillshadeRenderer.render call.
      const selectedKeys = new Set(
        selectFlatProjTiles(camera, PROJ_TYPE, 0, LAT, currentZ, W, H, DPR).map(
          (t) => `${t.z}/${t.x}/${t.y}`,
        ),
      )

      const drawn = drawnTiles(camera, zoom)
      expect(drawn.size).toBeGreaterThan(0)
      const missing = [...drawn].filter(([k]) => !selectedKeys.has(k)).map(([k, v]) => `${k} ${v}`)

      // The vector sibling (projection-aware SSE, tile-selection-cache.ts) selects every one of
      // the drawn tiles too — confirms `drawn` is a real projection-aware oracle, not an artefact
      // of this test's own math.
      const vecKeys = new Set(
        visibleTilesSSE(camera, getProjection('equirectangular', 0, LAT), zoom, W, H, 0, DPR).map(
          (t) => `${t.z}/${t.x}/${t.y}`,
        ),
      )
      expect([...drawn.keys()].filter((k) => !vecKeys.has(k))).toEqual([])

      expect(missing).toEqual([])
    })
  }
})

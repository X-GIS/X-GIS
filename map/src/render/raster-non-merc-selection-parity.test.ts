// #2302 — under a flat non-Mercator projection, every tile `vs_tile` places inside
// the viewport must be SELECTED (hence requested and drawn). Cull space == draw space.
//
// The raster twins (RasterRenderer / HillshadeRenderer) used to cull their flat
// branch with `visibleTilesFrustum` through a `{ name: 'non-mercator', forward:
// mercator.forward }` shim. That selector never calls `projection.forward` — it
// culls tile corners in MERCATOR metres — while `vs_tile` draws the same tiles
// through the display projection on the same MVP. At 60°N the Mercator cull
// frame is 2× taller than the equirect draw frame, so the poleward rows inside
// the equirect viewport landed beyond the Mercator cull window: never selected,
// never requested, a blank band at the poleward viewport edge.
//
// This witness projects tile corners EXACTLY as the shader's flat non-Mercator
// arm does (shaders/dsl/raster.ts): camera-relative longitude `lon − clon`,
// `project_geom` recentred on clon = 0 (`projectGeomCpu` is that function run on
// the CPU), minus the camera's projected 2D centre `camProj0 =
// projectCpu(projType, 0, clat, 0, clat)` (raster-renderer.ts packs the same),
// through `camera.getViewForProjection(projType)` — the matrix the renderer
// draws with. A tile whose projected quad intersects the viewport is "drawn".
//
// THREE assertions, deliberately:
//   FIX     drawn ⊆ selectFlatTiles(...)          — what #2302 requires.
//   TEETH   drawn ⊄ visibleTilesFrustum(mercator)  — the OLD cull provably misses
//           some of these tiles, so the FIX assertion distinguishes the two
//           selectors rather than passing on any non-empty set (§12: an
//           assertion carries information only if it distinguishes the states).
//   CONTROL drawn ⊆ visibleTilesSSE(equirectangular) — the vector path's
//           projection-aware selector already agrees with the shader; the raster
//           helper now routes through the same selector.
//
// Fail-before on main @ the #2302 report: z8 misses 8/127/72 + 8/128/72
// (screen y −201..45 — top 45 px visible); z10 misses 10/511/295 + 10/512/295.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { activeBody } from '@xgis/shared'
import { mercator as mercatorProj, mercatorYToLat, getProjection } from '@xgis/geo'
import { visibleTilesFrustum, visibleTilesSSE, tileBounds, type TileCoord } from '@xgis/data'
import { projectCpu, projectGeomCpu } from '../shaders/dsl/cpu-projections'
import { selectFlatTiles } from './flat-tile-selector'

const W = 1024
const H = 768
const DPR = 1
const EQUIRECT = 1 // projType — the table row for 'equirectangular'
const WINDOW = 8 // tiles enumerated each side of the centre tile, per axis

/** Column-major 4×4 × vec4 (the convention `Camera` matrices use). */
function mulMatVec4(m: Float32Array, v: readonly number[]): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + row]! * v[k]!
    r[row] = s
  }
  return r
}

const key = (t: { z: number; x: number; y: number }): string => `${t.z}/${t.x}/${t.y}`

/** The projection centre the host hands the renderer as proj_params.y/z for a
 *  flat projection — derived from the camera exactly as RasterRenderer.render
 *  derives its own `centerLon` / `centerLat` beside the selection. */
function projCentre(camera: Camera): { clon: number; clat: number } {
  const R = activeBody().sphereR
  return {
    clon: (camera.centerX / R) * (180 / Math.PI),
    clat: mercatorYToLat(camera.centerY),
  }
}

/** Tiles at zoom `z` whose vs_tile-projected quad intersects the viewport. */
function drawnTiles(camera: Camera, z: number): TileCoord[] {
  const { clon, clat } = projCentre(camera)
  const view = camera.getViewForProjection(EQUIRECT, W, H, DPR)
  const camProj0 = projectCpu(EQUIRECT, 0, clat, 0, clat)

  // Centre tile from the camera's lon/lat (XYZ scheme, rows from the top).
  const n = 1 << z
  const cx = Math.floor(((clon + 180) / 360) * n)
  const latRad = (clat * Math.PI) / 180
  const cy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)

  const out: TileCoord[] = []
  for (let y = Math.max(0, cy - WINDOW); y <= Math.min(n - 1, cy + WINDOW); y++) {
    for (let x = Math.max(0, cx - WINDOW); x <= Math.min(n - 1, cx + WINDOW); x++) {
      const t: TileCoord = { z, x, y, ox: x }
      const b = tileBounds(t)
      const tileRefLon = (b.west + b.east) / 2 - clon
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      let behind = false
      for (const [lon, lat] of [
        [b.west, b.south],
        [b.east, b.south],
        [b.east, b.north],
        [b.west, b.north],
      ] as const) {
        // shaders/dsl/raster.ts flat non-Mercator arm, on the CPU:
        const p = projectGeomCpu(EQUIRECT, lon - clon, lat, 0, clat, tileRefLon)
        const rel = [p[0] - camProj0[0], p[1] - camProj0[1], 0, 1]
        const clip = mulMatVec4(view.matrix, rel)
        if (clip[3] <= 0) {
          behind = true
          break
        }
        const sx = (clip[0] / clip[3]) * 0.5 * W + 0.5 * W
        const sy = 0.5 * H - (clip[1] / clip[3]) * 0.5 * H
        minX = Math.min(minX, sx)
        maxX = Math.max(maxX, sx)
        minY = Math.min(minY, sy)
        maxY = Math.max(maxY, sy)
      }
      if (behind) continue
      if (maxX < 0 || minX > W || maxY < 0 || minY > H) continue
      out.push(t)
    }
  }
  return out
}

function equirectCameraAt60N(zoom: number): Camera {
  const camera = new Camera(0, 60, zoom)
  camera.projType = EQUIRECT
  camera.pitch = 0
  camera.bearing = 0
  return camera
}

describe('#2302 flat non-Mercator raster selection — cull space == draw space', () => {
  for (const zoom of [8, 10]) {
    it(`z${zoom} @ 60°N equirectangular: every tile vs_tile draws on screen is selected`, () => {
      const camera = equirectCameraAt60N(zoom)
      const { clon, clat } = projCentre(camera)
      const drawn = drawnTiles(camera, zoom)
      expect(drawn.length, 'the witness must find tiles on screen').toBeGreaterThan(4)

      // FIX — the helper both raster twins now select through.
      const selected = new Set(
        selectFlatTiles(camera, EQUIRECT, clon, clat, zoom, W, H, DPR).map(key),
      )
      expect(selected.size).toBeGreaterThan(0)
      const missing = drawn.filter((t) => !selected.has(key(t))).map(key)
      expect(
        missing,
        `these tiles are drawn by vs_tile inside the ${W}×${H} viewport but never selected ` +
          `(so never requested): a blank band at the poleward edge`,
      ).toEqual([])

      // TEETH — the old Mercator-space cull misses some of these tiles. If this
      // ever turns empty, the FIX assertion above has stopped distinguishing the
      // two selectors and this witness is passing vacuously.
      const mercatorCulled = new Set(
        visibleTilesFrustum(camera, mercatorProj, zoom, W, H, 0, DPR).map(key),
      )
      const missedByMercatorCull = drawn.filter((t) => !mercatorCulled.has(key(t))).map(key)
      expect(
        missedByMercatorCull,
        'the Mercator-metre frustum cull must miss at least one drawn tile here — ' +
          'otherwise the camera is not one where the two selectors disagree',
      ).not.toEqual([])

      // CONTROL — the vector path's projection-aware selector agrees with the shader.
      const vectorSelected = new Set(
        visibleTilesSSE(
          camera,
          getProjection('equirectangular', clon, clat),
          zoom,
          W,
          H,
          0,
          DPR,
        ).map(key),
      )
      expect(drawn.filter((t) => !vectorSelected.has(key(t))).map(key)).toEqual([])
    })
  }

  it('Mercator (projType 0) still selects through the Mercator frustum cull, byte-identical', () => {
    const camera = new Camera(0, 60, 8)
    camera.projType = 0
    const viaHelper = selectFlatTiles(camera, 0, 0, 60, 8, W, H, DPR)
    const direct = visibleTilesFrustum(camera, mercatorProj, 8, W, H, 0, DPR)
    expect(viaHelper).toEqual(direct)
  })
})

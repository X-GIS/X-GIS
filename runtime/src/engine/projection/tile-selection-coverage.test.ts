// Projection-aware tile-selection COVERAGE.
//
// The existing tile-selection-projection.test.ts asserts the selector's
// output is in-range / finite / non-empty — but NOT that it actually
// COVERS the visible viewport. Under-selection (the user-reported blank
// tiles at the poles / dateline for non-Mercator projections) therefore
// passed silently: the flat selectors culled tiles using Mercator screen
// geometry while the GPU draws them with the active projection's geometry,
// so genuinely-visible high-latitude tiles were dropped.
//
// This is the renderer-faithful check. For a grid of screen samples we
// compute the lon/lat the GPU actually paints there (unproject through the
// SAME Mercator MVP the renderer uses → projection.inverse, mirroring
// renderer.ts: rtc = project(lon,lat) - project(centre)), then assert a
// selected tile's lon/lat bbox contains it. Samples beyond the Web
// Mercator pyramid limit (±85.0511°) are excluded — that band has no
// tiles to select (a separate polar-cap-synthesis concern).

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from '../../loader/tiles-sse'
import {
  mercator, equirectangular, naturalEarth, MERCATOR_LAT_LIMIT, type Projection,
} from './projection'
import { Camera } from './camera'

const W = 800, H = 800
const R = 6378137
const RAD2DEG = 180 / Math.PI

interface Tile { z: number; x: number; y: number; ox: number }

function tileLonLatBounds(t: Tile): { west: number; east: number; south: number; north: number } {
  const n = Math.pow(2, t.z)
  return {
    west: (t.x / n) * 360 - 180,
    east: ((t.x + 1) / n) * 360 - 180,
    north: Math.atan(Math.sinh(Math.PI * (1 - 2 * t.y / n))) * RAD2DEG,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (t.y + 1) / n))) * RAD2DEG,
  }
}

function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180
}

/** Fraction of in-(pyramid)-range viewport samples covered by some
 *  selected tile, using the renderer's own screen→lon/lat mapping. */
function coverage(proj: Projection, cam: Camera, ctx: string): { covered: number; inRange: number; tiles: number } {
  const maxZ = Math.round(cam.zoom)
  const tiles = visibleTilesSSE(cam, proj, maxZ, W, H, 0, 1) as Tile[]
  const isMerc = proj.name === 'mercator'
  const camLon = (cam.centerX / R) * RAD2DEG
  const camLat = Math.max(-85, Math.min(85,
    (2 * Math.atan(Math.exp(cam.centerY / R)) - Math.PI / 2) * RAD2DEG))
  const centerProj = isMerc ? [0, 0] : proj.forward(camLon, camLat)

  const SAMPLES = 7
  let covered = 0, inRange = 0
  for (let iy = 0; iy < SAMPLES; iy++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const sx = (ix / (SAMPLES - 1)) * W
      const sy = (iy / (SAMPLES - 1)) * H
      const rel = cam.unprojectToZ0(sx, sy, W, H, 1)
      if (!rel) continue // ray above horizon — nothing rendered there
      let lon: number, lat: number
      if (isMerc) {
        lon = ((cam.centerX + rel[0]) / R) * RAD2DEG
        lat = (2 * Math.atan(Math.exp((cam.centerY + rel[1]) / R)) - Math.PI / 2) * RAD2DEG
      } else {
        ;[lon, lat] = proj.inverse(centerProj[0]! + rel[0], centerProj[1]! + rel[1])
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      // No Web Mercator tiles exist beyond the clamp latitude — exclude.
      if (Math.abs(lat) > MERCATOR_LAT_LIMIT) continue
      inRange++
      const lonW = wrapLon(lon)
      const hit = tiles.some((t) => {
        const b = tileLonLatBounds(t)
        return lonW >= b.west - 1e-6 && lonW <= b.east + 1e-6
          && lat >= b.south - 1e-6 && lat <= b.north + 1e-6
      })
      if (hit) covered++
    }
  }
  expect(inRange, `${ctx} produced no in-range samples`).toBeGreaterThan(0)
  return { covered, inRange, tiles: tiles.length }
}

function assertCovered(proj: Projection, lon: number, lat: number, zoom: number, ctx: string): void {
  const cam = new Camera(lon, lat, zoom)
  const { covered, inRange } = coverage(proj, cam, ctx)
  expect(covered / inRange, `${ctx}: only ${covered}/${inRange} viewport samples covered`).toBeGreaterThanOrEqual(0.9)
}

describe('projection-aware selector covers the viewport (mercator control)', () => {
  for (const [lon, lat, z] of [[0, 0, 2], [0, 80, 4], [179.9, 0, 3], [126.978, 37.566, 8]] as const) {
    it(`mercator @ ${lon},${lat} z${z}`, () => {
      assertCovered(mercator, lon, lat, z, `merc-${lon}-${lat}-z${z}`)
    })
  }
})

describe('equirectangular covers the viewport at poles + dateline (regression: blank tiles)', () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 2], [0, 80, 4], [0, 84, 5],          // poles
    [180, 0, 3], [179.5, 0, 3], [-179.5, 0, 3], // dateline
    [126.978, 37.566, 8],                        // mid-latitude
  ]
  for (const [lon, lat, z] of cases) {
    it(`equirect @ ${lon},${lat} z${z}`, () => {
      assertCovered(equirectangular(lon), lon, lat, z, `equirect-${lon}-${lat}-z${z}`)
    })
  }
})

describe('natural_earth covers the viewport at poles + dateline', () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 2], [0, 80, 4], [180, 0, 3], [126.978, 37.566, 8],
  ]
  for (const [lon, lat, z] of cases) {
    it(`natural_earth @ ${lon},${lat} z${z}`, () => {
      assertCovered(naturalEarth(lon), lon, lat, z, `ne-${lon}-${lat}-z${z}`)
    })
  }
})

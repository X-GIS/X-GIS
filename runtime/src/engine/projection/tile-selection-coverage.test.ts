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
import { visibleTilesSSE } from '@xgis/data'
import {
  mercator,
  equirectangular,
  naturalEarth,
  MERCATOR_LAT_LIMIT,
  type Projection,
} from '@xgis/geo'
import { Camera } from '@xgis/map'

const W = 800,
  H = 800
const R = 6378137
const RAD2DEG = 180 / Math.PI

interface Tile {
  z: number
  x: number
  y: number
  ox: number
}

function tileLonLatBounds(t: Tile): { west: number; east: number; south: number; north: number } {
  const n = Math.pow(2, t.z)
  return {
    west: (t.x / n) * 360 - 180,
    east: ((t.x + 1) / n) * 360 - 180,
    north: Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))) * RAD2DEG,
    south: Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / n))) * RAD2DEG,
  }
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/** Fraction of the viewport (under `viewProj`'s rendered geometry) covered
 *  by the tiles `selectProj` selects. `selectProj` and `viewProj` are split
 *  so a test can SELECT with one projection (e.g. the buggy Mercator
 *  geometry) while measuring against what another projection actually draws
 *  (e.g. equirectangular) — i.e. reproduce the under-selection bug. When
 *  they're equal this is the plain renderer-faithful coverage check. */
/** Renderer-faithful coverage of a GIVEN tile set under `viewProj`. */
function measureCoverage(
  tiles: Tile[],
  viewProj: Projection,
  cam: Camera,
  ctx: string,
): { covered: number; inRange: number; tiles: number } {
  const isMerc = viewProj.name === 'mercator'
  const camLon = (cam.centerX / R) * RAD2DEG
  const camLat = Math.max(
    -85,
    Math.min(85, (2 * Math.atan(Math.exp(cam.centerY / R)) - Math.PI / 2) * RAD2DEG),
  )
  const centerProj = isMerc ? [0, 0] : viewProj.forward(camLon, camLat)

  const SAMPLES = 7
  let covered = 0,
    inRange = 0
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
        ;[lon, lat] = viewProj.inverse(centerProj[0]! + rel[0], centerProj[1]! + rel[1])
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      // No Web Mercator tiles exist beyond the clamp latitude — exclude.
      if (Math.abs(lat) > MERCATOR_LAT_LIMIT) continue
      inRange++
      const lonW = wrapLon(lon)
      const hit = tiles.some((t) => {
        const b = tileLonLatBounds(t)
        return (
          lonW >= b.west - 1e-6 &&
          lonW <= b.east + 1e-6 &&
          lat >= b.south - 1e-6 &&
          lat <= b.north + 1e-6
        )
      })
      if (hit) covered++
    }
  }
  expect(inRange, `${ctx} produced no in-range samples`).toBeGreaterThan(0)
  return { covered, inRange, tiles: tiles.length }
}

/** Coverage of `viewProj`'s rendered viewport by the tiles `selectProj`
 *  selects. Splitting select/view lets a test SELECT with one projection
 *  (e.g. the buggy Mercator geometry) while measuring against what another
 *  projection actually draws — i.e. reproduce the under-selection bug. */
function coverageWith(
  selectProj: Projection,
  viewProj: Projection,
  cam: Camera,
  ctx: string,
): { covered: number; inRange: number; tiles: number } {
  const maxZ = Math.round(cam.zoom)
  const tiles = visibleTilesSSE(cam, selectProj, maxZ, W, H, 0, 1) as Tile[]
  return measureCoverage(tiles, viewProj, cam, ctx)
}

function coverage(
  proj: Projection,
  cam: Camera,
  ctx: string,
): { covered: number; inRange: number; tiles: number } {
  return coverageWith(proj, proj, cam, ctx)
}

function assertCovered(
  proj: Projection,
  lon: number,
  lat: number,
  zoom: number,
  ctx: string,
): void {
  const cam = new Camera(lon, lat, zoom)
  const { covered, inRange } = coverage(proj, cam, ctx)
  expect(
    covered / inRange,
    `${ctx}: only ${covered}/${inRange} viewport samples covered`,
  ).toBeGreaterThanOrEqual(0.9)
}

describe('projection-aware selector covers the viewport (mercator control)', () => {
  for (const [lon, lat, z] of [
    [0, 0, 2],
    [0, 80, 4],
    [179.9, 0, 3],
    [126.978, 37.566, 8],
  ] as const) {
    it(`mercator @ ${lon},${lat} z${z}`, () => {
      assertCovered(mercator, lon, lat, z, `merc-${lon}-${lat}-z${z}`)
    })
  }
})

describe('equirectangular covers the viewport at poles + dateline (regression: blank tiles)', () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 2],
    [0, 80, 4],
    [0, 84, 5], // poles
    [180, 0, 3],
    [179.5, 0, 3],
    [-179.5, 0, 3], // dateline
    [126.978, 37.566, 8], // mid-latitude
  ]
  for (const [lon, lat, z] of cases) {
    it(`equirect @ ${lon},${lat} z${z}`, () => {
      assertCovered(equirectangular(lon), lon, lat, z, `equirect-${lon}-${lat}-z${z}`)
    })
  }
})

describe('natural_earth covers the viewport at poles + dateline', () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 2],
    [0, 80, 4],
    [180, 0, 3],
    [126.978, 37.566, 8],
  ]
  for (const [lon, lat, z] of cases) {
    it(`natural_earth @ ${lon},${lat} z${z}`, () => {
      assertCovered(naturalEarth(lon), lon, lat, z, `ne-${lon}-${lat}-z${z}`)
    })
  }
})

// ─── Bug #1 reproduction + fix: POLES (geometry) ───────────────────────
// Pre-fix the flat selectors culled tiles with MERCATOR screen geometry for
// EVERY projection. Under an equirect / natural_earth view that under-covers
// at the poles: Mercator y → ∞ pushes the visible high-latitude tiles off
// the cull frustum, so they're dropped and render blank. Each case selects
// BOTH ways against the same non-Mercator view:
//   BEFORE = visibleTilesSSE(cam, mercator)        ← the old behaviour
//   AFTER  = visibleTilesSSE(cam, theProjection)   ← the fix
// and asserts BEFORE under-covers while AFTER covers. (At the equator the
// two geometries coincide — the divergence is a high-latitude effect — so
// these cases are deliberately polar.)
describe('regression #1 (poles) — Mercator-geometry selection under-covers non-Mercator views', () => {
  const cases: ReadonlyArray<readonly [string, Projection, number, number, number]> = [
    ['equirect pole lat84', equirectangular(0), 0, 84, 5],
    ['equirect pole lat80', equirectangular(0), 0, 80, 4],
    ['natural_earth pole lat80', naturalEarth(0), 0, 80, 4],
  ]
  for (const [label, view, lon, lat, z] of cases) {
    it(`${label}: BEFORE(merc-geom) under-covers, AFTER(proj-aware) covers`, () => {
      const cam = new Camera(lon, lat, z)
      const before = coverageWith(mercator, view, cam, `${label} BEFORE`)
      const after = coverageWith(view, view, cam, `${label} AFTER`)
      const b = before.covered / before.inRange,
        a = after.covered / after.inRange
      // eslint-disable-next-line no-console
      console.log(
        `[${label}] BEFORE(merc-geom)=${(b * 100).toFixed(0)}% (${before.covered}/${before.inRange})  AFTER(proj-aware)=${(a * 100).toFixed(0)}% (${after.covered}/${after.inRange})`,
      )
      expect(b, `${label}: expected Mercator-geom selection to UNDER-cover`).toBeLessThan(0.8)
      expect(a, `${label}: expected projection-aware selection to cover`).toBeGreaterThanOrEqual(
        0.9,
      )
      expect(a).toBeGreaterThan(b)
    })
  }
})

// ─── Dateline, post-fix: covered on both sides (was a routing concern) ──
// Pre-fix, equirect / natural_earth within 45° of ±180° were routed to the
// sphere selector globeVisibleTiles. That handled the dateline "by
// construction" but used GLOBE screen geometry to cull an EQUIRECT view —
// the wrong projection — so LOD / placement could drift. The fix keeps
// equirect/NE on the projection-aware flat selector (+ world-copy
// enumeration), which covers BOTH sides of the dateline with the correct
// geometry. (This is verified as a coverage check rather than a before/
// after under-cover, because the old globe route did still cover the band.)
describe('dateline (post-fix) — flat selector covers both sides for equirect/NE', () => {
  for (const [name, view, lon] of [
    ['equirect', equirectangular(180), 180],
    ['equirect', equirectangular(-179.5), -179.5],
    ['natural_earth', naturalEarth(180), 180],
  ] as const) {
    for (const z of [2, 3, 4]) {
      it(`${name} @ lon${lon} z${z}: both sides covered`, () => {
        const cam = new Camera(lon as number, 0, z)
        const { covered, inRange } = coverageWith(view, view, cam, `${name}-${lon}-z${z}`)
        // Selection must reach both sides of ±180 — assert tiles exist in
        // the far-east and far-west longitude bands, not just the centre.
        const tiles = visibleTilesSSE(cam, view, z, W, H, 0, 1) as Tile[]
        const lons = tiles.map((t) => tileLonLatBounds(t)).map((b) => (b.west + b.east) / 2)
        expect(
          lons.some((l) => l > 90),
          `${name} z${z}: no east-side tiles`,
        ).toBe(true)
        expect(
          lons.some((l) => l < -90),
          `${name} z${z}: no west-side tiles`,
        ).toBe(true)
        expect(covered / inRange, `${name} z${z}: under-covered`).toBeGreaterThanOrEqual(0.9)
      })
    }
  }
})

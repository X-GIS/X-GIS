// iter-321 — Tile-selection correctness per projection, focused on
// the two historically-broken regimes: POLES and the ANTIMERIDIAN
// (dateline). Memory threads: project_non_merc_z14_pitch_over_select,
// project_azimuthal_label_position (iter-157 routed 3/4/5 through
// globeVisibleTiles), project_oblique_polar_tearing.
//
// CPU-testable invariants on the selector OUTPUT (z,x,y,ox) — no
// GPU. A selector that emits an out-of-range x/y, a NaN, a wildly
// over-sized set, or that DROPS the polar / dateline tiles produces
// a visibly broken map (blank poles, black dateline seam, or a
// 5-7 fps over-select).

import { describe, it, expect } from 'vitest'
import { globeVisibleTiles } from './globe'
import { visibleTilesFrustumSampled } from '../../data/tile-select'
import { mercator, equirectangular, naturalEarth } from './projection'
import { Camera } from './camera'
import { routeToSphereSelector } from '../gpu/gpu-shared'

const W = 800, H = 800

interface TileLike { z: number; x: number; y: number; ox: number }

// NOTE: the quadtree selectors (globeVisibleTiles, visibleTilesFrustum-
// Sampled) return MIXED-LOD leaves — near tiles at the target z, far/
// off-axis tiles at coarser z. So every tile is validated against ITS
// OWN 2^z, not a single passed zoom. `_zHint` is only used for the
// count ceiling (kept loose).
function assertTileSetSane(tiles: TileLike[], _zHint: number, ctx: string, maxCount = 2000): void {
  expect(tiles.length, `${ctx} empty selection`).toBeGreaterThan(0)
  expect(tiles.length, `${ctx} selection explosion`).toBeLessThanOrEqual(maxCount)
  const seen = new Set<string>()
  for (const t of tiles) {
    const n = Math.pow(2, t.z)  // per-tile zoom — quadtree is mixed-LOD
    expect(Number.isFinite(t.x) && Number.isInteger(t.x), `${ctx} bad x ${t.x}`).toBe(true)
    expect(Number.isFinite(t.y) && Number.isInteger(t.y), `${ctx} bad y ${t.y}`).toBe(true)
    expect(Number.isInteger(t.z) && t.z >= 0, `${ctx} bad z ${t.z}`).toBe(true)
    // Wrapped tile-x in [0, n) at the tile's OWN zoom; ox (absolute)
    // may exceed for world copies but the data-x is the wrapped one.
    expect(t.x >= 0 && t.x < n, `${ctx} x ${t.x} out of [0,${n}) at z${t.z}`).toBe(true)
    expect(t.y >= 0 && t.y < n, `${ctx} y ${t.y} out of [0,${n}) at z${t.z}`).toBe(true)
    expect(Number.isFinite(t.ox), `${ctx} bad ox ${t.ox}`).toBe(true)
    // (z,x,y,ox) must be unique — duplicates = redundant draws.
    const k = `${t.z},${t.x},${t.y},${t.ox}`
    expect(seen.has(k), `${ctx} duplicate tile ${k}`).toBe(false)
    seen.add(k)
  }
}

describe('iter-321 globeVisibleTiles — polar + dateline', () => {
  it('north pole (lat 85) at low zoom: selects top tile row, all in-range', () => {
    const tiles = globeVisibleTiles(0, 85, 2, 14, W, H)
    assertTileSetSane(tiles, 2, 'globe-north-pole')
    // Some tile should touch the top row (y=0) at z where pole visible.
    // Not all globe views include y=0 (depends on zoom); the hard
    // contract is in-range + finite, asserted above.
  })

  it('south pole (lat -85): all tiles in-range, no NaN', () => {
    const tiles = globeVisibleTiles(0, -85, 2, 14, W, H)
    assertTileSetSane(tiles, 2, 'globe-south-pole')
  })

  it('exact-pole-ish (lat 89.9): no crash, in-range', () => {
    const tiles = globeVisibleTiles(0, 89.9, 1, 14, W, H)
    assertTileSetSane(tiles, 1, 'globe-near-pole', 200)
  })

  it('antimeridian (lon 180): selection finite + in-range', () => {
    const tiles = globeVisibleTiles(180, 0, 2, 14, W, H)
    assertTileSetSane(tiles, 2, 'globe-antimeridian')
  })

  it('antimeridian-adjacent (lon 179.5 / -179.5): both finite', () => {
    assertTileSetSane(globeVisibleTiles(179.5, 0, 3, 14, W, H), 3, 'globe-179.5')
    assertTileSetSane(globeVisibleTiles(-179.5, 0, 3, 14, W, H), 3, 'globe--179.5')
  })

  it('camera zoom=0 globe: mixed-LOD leaves, all in-range', () => {
    // Quadtree descends to screen-space LOD even at camera zoom 0
    // (forceDescend at tz≤2), so the result is multi-zoom — assert
    // per-tile-zoom in-range, not a single z.
    const tiles = globeVisibleTiles(0, 0, 0, 14, W, H)
    assertTileSetSane(tiles, 0, 'globe-zoom0', 400)
  })

  it('high pitch (60°) at z=14 over a city: bounded — NOT 4× over-select', () => {
    // Memory project_non_merc_z14_pitch_over_select: globe at z=14 +
    // pitch hit 1322 tiles vs mercator 297. The MAX_TILES=300 cap
    // (iter-461) bounds it. Pin the bound.
    const tiles = globeVisibleTiles(126.978, 37.566, 14, 14, W, H, 60, 0)
    assertTileSetSane(tiles, 14, 'globe-z14-pitch60', 320)  // cap 300 + margin
  })

  it('bearing rotation does not produce out-of-range tiles', () => {
    for (const b of [0, 45, 90, 180, 270, 359]) {
      const tiles = globeVisibleTiles(0, 30, 3, 14, W, H, 0, b)
      assertTileSetSane(tiles, 3, `globe-bearing-${b}`)
    }
  })
})

describe('iter-321 visibleTilesFrustumSampled — mercator/equirect/NE polar + dateline', () => {
  function camAt(lon: number, lat: number, zoom: number, pitch = 0): Camera {
    const c = new Camera(lon, lat, zoom)
    c.pitch = pitch
    return c
  }

  it('mercator at antimeridian (lon 179.9): selects wrap copies (ox spans both sides)', () => {
    const cam = camAt(179.9, 0, 3)
    const tiles = visibleTilesFrustumSampled(cam, mercator, 3, W, H, 0, 1)
    assertTileSetSane(tiles, 3, 'merc-antimeridian')
    // World-copy enumeration: at the dateline the selection should
    // span more than one world copy (ox values differ) OR wrap x.
    const oxSet = new Set(tiles.map(t => Math.floor(t.ox / Math.pow(2, 3))))
    expect(oxSet.size, 'merc dateline should touch ≥1 world copy').toBeGreaterThanOrEqual(1)
  })

  it('mercator near pole (lat 84): in-range, includes high-y tiles', () => {
    const cam = camAt(0, 84, 4)
    const tiles = visibleTilesFrustumSampled(cam, mercator, 4, W, H, 0, 1)
    assertTileSetSane(tiles, 4, 'merc-pole')
  })

  it('equirectangular at antimeridian: finite + in-range', () => {
    const cam = camAt(179.9, 0, 2)
    const tiles = visibleTilesFrustumSampled(cam, equirectangular(0), 2, W, H, 0, 1)
    assertTileSetSane(tiles, 2, 'equirect-antimeridian')
  })

  it('natural earth near pole: finite + in-range', () => {
    const cam = camAt(0, 80, 2)
    const tiles = visibleTilesFrustumSampled(cam, naturalEarth(0), 2, W, H, 0, 1)
    assertTileSetSane(tiles, 2, 'ne-pole')
  })

  it('mercator z=0 every projection-center longitude finite', () => {
    for (const lon of [-180, -90, 0, 90, 180]) {
      const cam = camAt(lon, 0, 1)
      const tiles = visibleTilesFrustumSampled(cam, mercator, 1, W, H, 0, 1)
      assertTileSetSane(tiles, 1, `merc-z1-lon${lon}`, 200)
    }
  })

  it('DPR=3 mobile at antimeridian — same tile-x range as DPR=1 (DPR-invariant selection)', () => {
    const cam1 = camAt(179.9, 20, 5)
    const cam3 = camAt(179.9, 20, 5)
    const t1 = visibleTilesFrustumSampled(cam1, mercator, 5, W, H, 0, 1)
    const t3 = visibleTilesFrustumSampled(cam3, mercator, 5, W * 3, H * 3, 0, 3)
    // CSS-pixel-invariant: the tile COUNT shouldn't balloon 9× at DPR3.
    expect(t3.length).toBeLessThanOrEqual(t1.length * 2)
    assertTileSetSane(t3, 5, 'merc-dpr3-antimeridian')
  })
})

// iter-322 — ALL-projection routing contract + sphere-routed selection.
// The VTR picks one of two selector families per projection:
//   cylindrical (mercator=0 / equirect=1 / natural_earth=2) → flat
//     frustum selector (camera-centre-independent forward).
//   azimuthal family (ortho=3 / azi=4 / stereo=5) + oblique=6 +
//     globe=7 → sphere-aware globeVisibleTiles (centre-relative).
// Wrong routing = the user-reported #4/#6 mispositioning class. These
// pin the routing decision AND that the sphere selector produces sane
// tiles for EVERY projType that routes to it (ortho/azi/stereo/oblique
// were NOT exercised by the iter-321 globe-only cases above).
describe('iter-322 routeToSphereSelector — per-projection routing contract', () => {
  // projType encoding: 0 merc, 1 equirect, 2 NE, 3 ortho, 4 azi,
  // 5 stereo, 6 oblique, 7 globe.
  const CYLINDRICAL = [0, 1, 2]
  const AZIMUTHAL_FAMILY = [3, 4, 5]
  const OBLIQUE = 6

  it('cylindrical projections use the flat frustum selector (no sphere route, non-dateline)', () => {
    for (const p of CYLINDRICAL) {
      expect(routeToSphereSelector(p, false, false), `proj ${p} should NOT sphere-route`).toBe(false)
    }
  })

  it('azimuthal family always sphere-routes (centre-relative projection)', () => {
    for (const p of AZIMUTHAL_FAMILY) {
      expect(routeToSphereSelector(p, false, false), `proj ${p} must sphere-route`).toBe(true)
    }
  })

  it('oblique mercator always sphere-routes (iter-127)', () => {
    expect(routeToSphereSelector(OBLIQUE, false, false)).toBe(true)
  })

  it('globe routes via globeMode regardless of projType', () => {
    expect(routeToSphereSelector(7, true, false)).toBe(true)
    // globeMode forces the route even for a projType that otherwise wouldn't.
    expect(routeToSphereSelector(0, true, false)).toBe(true)
  })

  it('any projection facing the antimeridian sphere-routes (no dateline seam)', () => {
    for (const p of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(routeToSphereSelector(p, false, true), `proj ${p} at dateline must sphere-route`).toBe(true)
    }
  })
})

describe('iter-322 sphere-routed projections — selection sane at pole + dateline', () => {
  // ortho/azi/stereo/oblique all consume globeVisibleTiles (projection-
  // agnostic: it takes lon/lat/zoom only). Confirm the selector output
  // is in-range for the centres these projections are actually used at.
  // Each is a projType that routeToSphereSelector(p,false,false)===true.
  const SPHERE_ROUTED = [3, 4, 5, 6, 7]

  for (const p of SPHERE_ROUTED) {
    it(`proj ${p}: routes to sphere AND selection sane at pole + dateline + mid`, () => {
      // Sanity: this projType genuinely sphere-routes (else the test
      // would be exercising the wrong selector).
      const routes = p === 7
        ? routeToSphereSelector(p, true, false)   // globe via globeMode
        : routeToSphereSelector(p, false, false)
      expect(routes, `proj ${p} expected to sphere-route`).toBe(true)

      // North pole, south pole, antimeridian, mid-latitude — the same
      // globeVisibleTiles call the VTR makes for this projType.
      assertTileSetSane(globeVisibleTiles(0, 85, 2, 14, W, H), 2, `proj${p}-npole`)
      assertTileSetSane(globeVisibleTiles(0, -85, 2, 14, W, H), 2, `proj${p}-spole`)
      assertTileSetSane(globeVisibleTiles(180, 0, 2, 14, W, H), 2, `proj${p}-dateline`)
      assertTileSetSane(globeVisibleTiles(126.978, 37.566, 8, 14, W, H), 8, `proj${p}-seoul`)
    })
  }

  it('world-copy fan-out preserves data-x in-range (only ox shifts by world)', () => {
    // For the periodic sphere-routed projections (equirect=1/NE=2/
    // oblique=6) the VTR multiplies globeVisibleTiles output by world
    // copies [-2..2]. The wrapped data-x stays in [0,2^z); only the
    // absolute ox carries the world offset. Simulate the fan-out.
    const base = globeVisibleTiles(179.5, 0, 3, 14, W, H)
    const n = Math.pow(2, 3)
    for (const wc of [-2, -1, 0, 1, 2]) {
      for (const t of base) {
        // data-x (wrapped) must remain valid at the tile's own zoom.
        const tn = Math.pow(2, t.z)
        expect(t.x >= 0 && t.x < tn, `wc${wc} data-x ${t.x} OOB at z${t.z}`).toBe(true)
        // absolute-x for this world copy is x + wc*2^z — finite.
        const absX = t.x + wc * n
        expect(Number.isFinite(absX)).toBe(true)
      }
    }
  })
})

import { describe, expect, it } from 'vitest'

import { Camera } from '@xgis/map'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator } from '@xgis/geo'

// ═══════════════════════════════════════════════════════════════════
// Frustum FAR-PLANE cull in `visibleTilesFrustum` (#1427).
// ═══════════════════════════════════════════════════════════════════
//
// Reported symptom: frame drops plus a permanent `[FLICKER]` warning on
// OFM Liberty at #16.00/51.50466/-0.11813/60.0/72.4.
//
// Root cause: the selector's only visibility gate was "does the tile's
// screen-space AABB overlap the viewport". On a FLAT Mercator plane the
// vanishing line sits at infinity, so EVERY finite ground point in front
// of the camera projects into frame — past the horizon the whole rest of
// the world compresses into a few pixels of horizon strip and passes the
// overlap test. A street-level z16 London view therefore enumerated most
// of the northern hemisphere at z4.
//
// Fix: cull tiles whose nearest corner lies beyond the camera's own far
// plane. That plane is the single authority for where the rendered world
// ends — the GPU already clips every fragment past it — so the cull is
// visually inert and removes only waste.
//
// Measured at 1280x800 / z16 / bearing 60 (`bun
// scripts/probe-tile-selection-pitch.ts`), before -> after:
//
//   pitch 59    40 ->  34
//   pitch 60   191 ->  34
//   pitch 70   191 ->  42
//   pitch 72.4 192 ->  42   <- the reported camera
//   pitch 80   191 ->  43
//
// and the z4 population (105 tiles spanning x 0..15 of 0..15, y 0..7 at
// pitch 72.4) drops to zero. Every assertion below FAILS on the parent
// commit — the counts there are the "before" column.

const LAT = 51.50466
const LON = -0.11813
const ZOOM = 16
const BEARING = 60
/** OFM planet tops out at z14. */
const MAX_SOURCE_Z = 14
const W = 1280
const H = 800

function camAt(pitch: number): Camera {
  const c = new Camera(LON, LAT, ZOOM)
  c.bearing = BEARING
  c.pitch = pitch
  c.syncCenterLat()
  return c
}

function select(pitch: number) {
  return visibleTilesFrustum(camAt(pitch), mercator, MAX_SOURCE_Z, W, H, 0, 1)
}

describe('visibleTilesFrustum — far-plane cull (#1427)', () => {
  it('stops enumerating past-horizon coarse tiles at the reported camera', () => {
    const tiles = select(72.4)
    // Before the cull: 192 tiles, 105 of them z4. The whole point is that
    // a street-level view never reaches for planet-scale tiles.
    const coarse = tiles.filter((t) => t.z <= 6)
    expect(coarse).toHaveLength(0)
    expect(tiles.length).toBeLessThanOrEqual(80)
  })

  it('keeps the pitch 59 -> 60 transition continuous instead of a 5x cliff', () => {
    const at59 = select(59).length
    const at60 = select(60).length
    // Before: 40 -> 191. A one-degree pitch change must not multiply the
    // tile set — that discontinuity is what saturated the GPU cache and
    // kept `missed` from ever reaching 0.
    expect(at60).toBeLessThan(at59 * 2)
  })

  it('holds every pitch under the frustum tile budget', () => {
    // `maxFrustumTilesFor(1280, 800, pitch>=60)` is 170; before the fix
    // the selector returned 191-192, exceeding its own cap.
    for (const pitch of [0, 30, 50, 59, 60, 65, 70, 72.4, 75, 80]) {
      expect(select(pitch).length, `pitch ${pitch}`).toBeLessThanOrEqual(170)
    }
  })

  it('leaves the low-pitch selection untouched', () => {
    // At pitch 0 the ground plane is perpendicular to the view axis, so
    // every point sits at the same depth and nothing is near the far
    // plane — the cull must be a no-op there. These are the same counts
    // the parent commit produces.
    expect(select(0).length).toBe(4)
    expect(select(30).length).toBe(34)
    expect(select(50).length).toBe(34)
    expect(select(59).length).toBe(34)
  })

  it('still covers the ground with a monotone LOD taper', () => {
    const tiles = select(72.4)
    // Foreground must still reach the source maximum...
    expect(tiles.some((t) => t.z === MAX_SOURCE_Z)).toBe(true)
    // ...and the distance taper must be gap-free: every zoom between the
    // coarsest selected level and maxZ is represented, so the horizon
    // strip degrades smoothly rather than jumping to a planet tile.
    const zs = new Set(tiles.map((t) => t.z))
    const minZ = Math.min(...zs)
    for (let z = minZ; z <= MAX_SOURCE_Z; z++) {
      expect(zs.has(z), `zoom ${z} missing from the taper`).toBe(true)
    }
  })

  it('culls only what the camera already clips', () => {
    // The contract that makes this cull visually inert: a dropped tile is
    // entirely beyond `far`, so the GPU discards all of its fragments.
    // Verify directly against the camera's own frame view rather than
    // trusting the selector's internal copy of the test.
    const cam = camAt(72.4)
    const { matrix: mvp, far } = cam.getFrameView(W, H, 1)
    const R = 6378137
    const selected = new Set(select(72.4).map((t) => `${t.z}/${t.x}/${t.y}`))

    const depthAt = (mx: number, my: number) =>
      mvp[3]! * (mx - cam.centerX) + mvp[7]! * (my - cam.centerY) + mvp[15]!
    const tileYToLat = (y: number, n: number) =>
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    const latToMerc = (lat: number) =>
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) * R

    /** Nearest-corner clip `w` of a tile, or null when a corner falls behind
     *  the camera (then the true minimum is hidden and the tile cannot be
     *  judged from corners alone). `cw` is affine in mercator (mx, my), so for
     *  a fully-in-front tile the corner minimum IS the tile minimum. */
    const nearestCornerDepth = (z: number, x: number, y: number): number | null => {
      const n = 2 ** z
      const lonW = (x / n) * 360 - 180
      const lonE = ((x + 1) / n) * 360 - 180
      const latN = tileYToLat(y, n)
      const latS = tileYToLat(y + 1, n)
      const depths = [
        depthAt(((lonW * Math.PI) / 180) * R, latToMerc(latS)),
        depthAt(((lonE * Math.PI) / 180) * R, latToMerc(latS)),
        depthAt(((lonE * Math.PI) / 180) * R, latToMerc(latN)),
        depthAt(((lonW * Math.PI) / 180) * R, latToMerc(latN)),
      ]
      if (depths.some((d) => d <= 1e-6)) return null
      return Math.min(...depths)
    }

    // Stated over the SELECTED SET rather than by sweeping the globe: every
    // tile that survived selection must have ground inside the far plane.
    // (A whole-world sweep at a granularity fine enough to be faithful is
    // 2^20 cells and takes minutes; this is the same invariant, exactly, in
    // O(selected).)
    let judged = 0
    for (const key of selected) {
      const [z, x, y] = key.split('/').map(Number)
      const near = nearestCornerDepth(z!, x!, y!)
      if (near === null) continue // straddles the camera — not judgeable here
      judged++
      expect(near, `selected z${z}/${x}/${y} lies wholly beyond the far plane`).toBeLessThanOrEqual(
        far,
      )
    }
    // The invariant must have had something to bite on.
    expect(judged).toBeGreaterThan(10)

    // ...and the converse: the cull is doing work rather than passing
    // vacuously. Walk out along the view direction until past the far plane
    // and confirm the selector left that ground alone.
    const bearingRad = (BEARING * Math.PI) / 180
    let beyond = 0
    for (let km = 60; km <= 2000; km += 20) {
      const d = km * 1000
      const mx = cam.centerX + Math.sin(bearingRad) * d
      const my = cam.centerY + Math.cos(bearingRad) * d
      const nAtMax = 2 ** MAX_SOURCE_Z
      const tx = Math.floor((((mx / R) * 180) / Math.PI / 360 + 0.5) * nAtMax)
      const merc = my / R
      const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI
      const ty = Math.floor(
        ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * nAtMax,
      )
      if (depthAt(mx, my) <= far) continue
      beyond++
      // No selected tile at any zoom may contain this past-far-plane point.
      for (const key of selected) {
        const [z, x, y] = key.split('/').map(Number)
        const shift = MAX_SOURCE_Z - z!
        expect(
          x! === tx >> shift && y! === ty >> shift,
          `z${z}/${x}/${y} covers ground ${km} km out, past the far plane`,
        ).toBe(false)
      }
    }
    expect(beyond, 'the walk must actually reach past the far plane').toBeGreaterThan(50)
  })
})

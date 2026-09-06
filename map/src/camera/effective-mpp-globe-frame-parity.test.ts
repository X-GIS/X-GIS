// #2332 — `Camera.effectiveMpp` must return the world scale the matrix
// `getViewForProjection` ACTUALLY returns renders at (its own documented
// contract, camera.ts). In globeMode that matrix does NOT come from
// `buildECEFFrameView`: `getECEFFrameView` short-circuits into `_globeFrame` →
// `buildGlobeFrame` → `globeAltitude`, which is UNCAPPED for the perspective
// globe (#450) and uses the FLAT per-projType cap for the azimuthal-promoted
// disc. `effectiveMpp` mirrored `buildECEFFrameView`'s `min(WORLD_MERC·cosLat,
// 2·EARTH_R)` cap instead — a builder that never runs in globeMode — so below
// z* (≈2.7 on a 1080 px canvas, i.e. the default whole-earth opening view)
// every metre-scaled size consumer (dash arrays, line patterns, metre/km/degree
// point radii, the lat-deg pan step) read a scale up to 6.6× off.
//
// These gates measure the scale from the MVP itself, so the mirror cannot
// silently unbind from the builder again.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'

const W = 1080,
  H = 1080,
  DPR = 1

const rawMppOf = (z: number) => WORLD_MERC / TILE_PX / Math.pow(2, z)

function mulMatVec4(
  m: Float32Array,
  v: [number, number, number, number],
): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + row] * v[k]
    r[row] = s
  }
  return r
}

/** Metres per CSS pixel the frame `getViewForProjection` ACTUALLY returns
 *  renders at, measured at the RTC origin (the focus point on the surface).
 *  The camera sits on the lon=0 meridian, where ECEF east is [0,1,0] at every
 *  latitude, and east is perpendicular to the orbit view direction at bearing 0
 *  — so the on-screen displacement of a 1 km east offset is the frame's true
 *  metre scale, independent of any cap formula. */
function measuredMpp(cam: Camera): number {
  const mvp = cam.getViewForProjection(7, W, H, DPR).matrix
  const d = 1000
  const a = mulMatVec4(mvp, [0, 0, 0, 1])
  const b = mulMatVec4(mvp, [0, d, 0, 1])
  const ax = (a[0] / a[3]) * 0.5 * W,
    ay = (a[1] / a[3]) * 0.5 * H
  const bx = (b[0] / b[3]) * 0.5 * W,
    by = (b[1] / b[3]) * 0.5 * H
  return d / Math.hypot(bx - ax, by - ay)
}

describe('#2332 effectiveMpp mirrors the GLOBE frame builder, not buildECEFFrameView', () => {
  it('globeMode is what setProjection(7) produces (the real render path)', () => {
    const cam = new Camera(0, 0, 0)
    expect(cam.setProjection(7)).toBe(7)
    expect(cam.globeMode).toBe(true)
    expect(cam.globeOrtho).toBe(false)
  })

  it('perspective globe: equals the scale the globe MVP renders at, at every zoom', () => {
    for (const lat of [0, 45]) {
      for (const z of [0, 1, 2, 3, 6]) {
        const cam = new Camera(0, lat, z)
        cam.setProjection(7)
        const measured = measuredMpp(cam)
        const eff = cam.effectiveMpp(7, H, DPR)
        expect(
          Math.abs(eff / measured - 1),
          `lat=${lat} z=${z}: effectiveMpp=${eff.toFixed(1)} m/px, MVP renders at ${measured.toFixed(1)} m/px (ratio ${(measured / eff).toFixed(3)})`,
        ).toBeLessThan(1e-3)
      }
    }
  })

  it('perspective globe: uncapped (#450) — the sub-cap band returns rawMpp', () => {
    // The pre-fix cos-lat cap returned 2·EARTH_R/1080 ≈ 11811 m/px at every
    // zoom below z*, i.e. 6.63× / 3.31× / 1.66× too small at z0 / z1 / z2.
    for (const z of [0, 1, 2]) {
      const cam = new Camera(0, 0, z)
      cam.setProjection(7)
      expect(cam.effectiveMpp(7, H, DPR)).toBe(rawMppOf(z))
    }
  })

  it('promoted azimuthal disc: equals the scale the ortho globe MVP renders at', () => {
    // Tilting ortho (3) / azimuthal_eq (4) / stereographic (5) promotes to the
    // globe path with globeOrtho set by the Map; globeAltitude then caps on the
    // FLAT per-projType cap keyed on the SOURCE kind (azimuthalProjType).
    for (const src of [3, 4, 5]) {
      for (const z of [0, 1, 2, 3, 6]) {
        const cam = new Camera(0, 0, z)
        cam.pitch = 25
        cam.globeOrtho = true
        expect(cam.setProjection(src)).toBe(7)
        const measured = measuredMpp(cam)
        const eff = cam.effectiveMpp(7, H, DPR)
        expect(
          Math.abs(eff / measured - 1),
          `azimuthalProjType=${src} z=${z}: effectiveMpp=${eff.toFixed(1)} m/px, MVP renders at ${measured.toFixed(1)} m/px`,
        ).toBeLessThan(1e-3)
      }
    }
  })
})

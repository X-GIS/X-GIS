import { describe, it, expect } from 'vitest'
import {
  panGlobeToScreenAnchor,
  zoomAtGlobeAnchored,
  unprojectGlobeFromCamera,
  type GlobeAnchorCamera,
} from './globe-anchor'
import { EARTH_R } from '@xgis/geo'

// ═══ Globe drag/zoom anchor loops — centre-jitter gate (real functions) ═══
//
// Guards the SHIPPED interaction path (globe-anchor.ts), the user-visible half of
// the "?proj=globe at Tokyo z17.7 엄청나게 흔들립니다, zoom+drag" report. Both loops
// pin a ground point under the cursor by unprojecting the globe every frame; the
// unproject inverts the absolute globe MVP. When that matrix and its inverse were
// f32 the ~1 m back-projection quantisation re-rolled each frame, so the loop's
// recovered centre (hence the whole render) shook 50–260 px at z17+. With the f64
// matrix + f64 inverse (globe.ts) the loops hold the centre rock-steady.
//
// Unlike the closed-form geo gate (globe-unproject-jitter.test.ts), this calls the
// REAL panGlobeToScreenAnchor / zoomAtGlobeAnchored, so it fails if ANY step of the
// shipped loop regresses — not just the matrix precision.

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const TILE_PX = 512

function mkCam(lon: number, lat: number, zoom: number): GlobeAnchorCamera {
  return {
    centerX: lon * DEG2RAD * EARTH_R,
    centerY: Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) * EARTH_R,
    centerLatDeg: lat,
    zoom,
    maxZoom: 24,
    minZoom: 0,
    pitch: 0,
    bearing: 0,
    projType: 7,
    globeOrtho: false,
    azimuthalProjType: 4,
  }
}
const lonOf = (c: GlobeAnchorCamera) => (c.centerX / EARTH_R) * RAD2DEG

/** peak-to-peak of the residual after removing a least-squares line — the shake
 *  left once the smooth intended drift is subtracted. */
function residualLineP2P(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0,
    sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const slope = sxy / sxx
  let lo = Infinity,
    hi = -Infinity
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (my + slope * (xs[i] - mx))
    if (r < lo) lo = r
    if (r > hi) hi = r
  }
  return hi - lo
}
/** peak-to-peak of the 3-point second difference — ~0 for any smooth trajectory
 *  (including the geometric zoom-toward-cursor curve), spikes only on jitter. */
function curvatureP2P(ys: number[]): number {
  let lo = Infinity,
    hi = -Infinity
  for (let i = 1; i < ys.length - 1; i++) {
    const d = ys[i] - (ys[i - 1] + ys[i + 1]) / 2
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return hi - lo
}

const ZOOMS = [15, 17.7, 19, 20.5]
const W = 1200,
  H = 800,
  DPR = 1

describe('globe drag anchor — centre holds steady under a smooth pan', () => {
  for (const zoom of ZOOMS) {
    it(`drag: centre jitter <0.1px over a 60px pan @z${zoom}`, () => {
      const cam = mkCam(139.83404, 35.68591, zoom)
      const px0 = W * 0.5,
        py0 = H * 0.5
      const anchor = unprojectGlobeFromCamera(cam, px0, py0, W, H, DPR)!
      const ks: number[] = [],
        lons: number[] = []
      for (let k = 1; k <= 60; k++) {
        panGlobeToScreenAnchor(cam, anchor[0], anchor[1], px0 + k, py0, W, H, DPR)
        ks.push(k)
        lons.push(lonOf(cam))
      }
      const pxPerDeg = ((TILE_PX * 2 ** zoom) / 360) * Math.cos(35.68591 * DEG2RAD)
      const jit = residualLineP2P(ks, lons) * pxPerDeg
      expect(jit, `drag centre jitter ${jit.toFixed(3)}px @z${zoom}`).toBeLessThan(0.1)
    })
  }
})

describe('globe zoom anchor — centre holds steady under a smooth wheel zoom', () => {
  for (const zoom of ZOOMS) {
    it(`zoom: centre jitter <0.1px over a wheel-zoom sequence @z${zoom}`, () => {
      const cam = mkCam(139.83404, 35.68591, zoom)
      const px = W * 0.62,
        py = H * 0.44
      const lons: number[] = [],
        lats: number[] = []
      for (let k = 1; k <= 40; k++) {
        zoomAtGlobeAnchored(cam, +0.02, px, py, W, H, DPR)
        lons.push(lonOf(cam))
        lats.push(cam.centerLatDeg)
      }
      const pxPerDegLon = ((TILE_PX * 2 ** zoom) / 360) * Math.cos(35.68591 * DEG2RAD)
      const pxPerDegLat = (TILE_PX * 2 ** zoom) / 360
      const jitLon = curvatureP2P(lons) * pxPerDegLon
      const jitLat = curvatureP2P(lats) * pxPerDegLat
      expect(jitLon, `zoom centre lon-jitter ${jitLon.toFixed(3)}px @z${zoom}`).toBeLessThan(0.1)
      expect(jitLat, `zoom centre lat-jitter ${jitLat.toFixed(3)}px @z${zoom}`).toBeLessThan(0.1)
    })
  }
})

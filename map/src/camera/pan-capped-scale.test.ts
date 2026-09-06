// #2322 — Camera.pan() must move the world by the metres each screen pixel is
// RENDERED at. The frame's scale is `effectiveMpp` (capped at whole-earth zooms:
// WORLD_MERC / cssH for Mercator, 2R / cssH for orthographic); pan() scaled by the
// raw tile-pyramid `WORLD_MERC / TILE_PX / 2^zoom`, so below the cap band the
// inertia glide and the off-ground drag fallback over-moved the map — 2.1× at
// Mercator z0 and 6.6× at ortho z0 on a 1080 px canvas — while the anchored drag
// (panToScreenAnchor, MVP-inverse) stayed under the cursor. The z3 rows are the
// control: above the cap band both scales coincide, so they pass before and after.
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { EARTH } from '@xgis/shared'

const W = 1080
const H = 1080
const R = EARTH.sphereR

function mercatorRatio(zoom: number): number {
  const a = new Camera(0, 0, zoom)
  a.projType = 0
  const b = new Camera(0, 0, zoom)
  b.projType = 0
  a.panToScreenAnchor(a.centerX, a.centerY, W / 2 + 10, H / 2, W, H, 1)
  b.pan(10, 0, W, H, 1)
  return Math.abs(b.centerX) / Math.abs(a.centerX)
}

function orthoRatio(zoom: number): number {
  const cam = new Camera(0, 0, zoom)
  cam.projType = 3
  cam.globeMode = false
  cam.pitchLocked = true
  cam.pitch = 0
  cam.bearing = 0
  const p0 = cam.unprojectToZ0(W / 2, H / 2, W, H, 1)
  const p1 = cam.unprojectToZ0(W / 2, H / 2 + 10, W, H, 1)
  expect(p0).not.toBeNull()
  expect(p1).not.toBeNull()
  const screenDeg = (Math.abs(p1![1] - p0![1]) / R) * (180 / Math.PI)
  const lat0 = cam.centerLatDeg
  cam.pan(0, 10, W, H, 1)
  const panDeg = Math.abs(cam.centerLatDeg - lat0)
  return panDeg / screenDeg
}

describe('#2322 — pan() scales by the rendered metres-per-pixel', () => {
  it('mercator z0 (inside the WORLD_MERC cap band at 1080 px): delta pan matches the anchored drag', () => {
    const r = mercatorRatio(0)
    expect(Math.abs(r - 1), `pan/anchored-drag ratio ${r.toFixed(3)}`).toBeLessThan(0.01)
  })

  it('mercator z3 (above the cap band): control, unchanged', () => {
    const r = mercatorRatio(3)
    expect(Math.abs(r - 1), `pan/anchored-drag ratio ${r.toFixed(3)}`).toBeLessThan(0.01)
  })

  it('orthographic z0 (inside the 2R cap band): 10 px delta pan rotates the centre by the on-screen 10 px', () => {
    const r = orthoRatio(0)
    expect(Math.abs(r - 1), `pan/on-screen ratio ${r.toFixed(3)}`).toBeLessThan(0.01)
  })

  it('orthographic z3 (above the cap band): control, unchanged', () => {
    const r = orthoRatio(3)
    expect(Math.abs(r - 1), `pan/on-screen ratio ${r.toFixed(3)}`).toBeLessThan(0.01)
  })
})

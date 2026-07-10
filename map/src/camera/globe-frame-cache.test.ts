// ═══ _globeFrame dirty-gate (#784) ═══
//
// In globe mode the render loop reads getRTCMatrix / getFrameView /
// getECEFFrameView in one frame; each routed to `_globeFrame`, which had NO
// dirty-gate (unlike `_buildRTCMatrix`'s 9-field cache) — up to three full
// buildGlobeFrame runs per frame on an unchanged camera. The gate keys on
// every scalar the pure builder reads; `_globeGeneration` (mirroring the RTC
// path's `_mvpGeneration`) is the observable that pins it.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'

const W = 800
const H = 600
const DPR = 2

interface GlobeCacheProbe {
  _globeGeneration: number
}
const gen = (c: Camera): number => (c as unknown as GlobeCacheProbe)._globeGeneration

function globeCamera(): Camera {
  const c = new Camera(127, 37.5, 4)
  c.globeMode = true
  c.projType = 7
  return c
}

describe('Camera._globeFrame dirty-gate (#784)', () => {
  it('the three frame-view getters on an unchanged camera build ONCE', () => {
    const c = globeCamera()
    const m1 = c.getRTCMatrix(W, H, DPR)
    const v = c.getFrameView(W, H, DPR)
    const e = c.getECEFFrameView(W, H, DPR)
    expect(gen(c)).toBe(1) // one real build, two cache hits
    // All three surface the SAME preallocated matrix with identical bytes.
    expect(v.matrix).toBe(m1)
    expect(e.matrix).toBe(m1)
    expect(e.far).toBe(v.far)
    expect(e.eye).toBeDefined()
  })

  it('cached values are byte-identical to a fresh camera at the same state', () => {
    const a = globeCamera()
    // Warm the cache, then read again through a different getter.
    a.getFrameView(W, H, DPR)
    const cached = a.getECEFFrameView(W, H, DPR)
    const b = globeCamera()
    const fresh = b.getECEFFrameView(W, H, DPR)
    expect(Array.from(cached.matrix)).toEqual(Array.from(fresh.matrix))
    expect(cached.far).toBe(fresh.far)
    expect(cached.eye).toEqual(fresh.eye)
  })

  it('every key field invalidates: viewport, dpr, centre, lat, zoom, bearing, pitch, ortho, aziProj', () => {
    const c = globeCamera()
    c.getFrameView(W, H, DPR)
    expect(gen(c)).toBe(1)

    c.getFrameView(W + 1, H, DPR)
    expect(gen(c)).toBe(2) // width
    c.getFrameView(W + 1, H + 1, DPR)
    expect(gen(c)).toBe(3) // height
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(4) // dpr

    c.centerX += 1000
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(5)
    c.centerLatDeg += 0.5
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(6)
    c.zoom += 0.25
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(7)
    c.bearing = 15
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(8)
    c.pitch = 30
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(9)
    c.globeOrtho = true
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(10)
    c.azimuthalProjType = 3
    c.getFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(11)

    // And back to steady state: no key change → no rebuild.
    c.getRTCMatrix(W + 1, H + 1, 1)
    c.getECEFFrameView(W + 1, H + 1, 1)
    expect(gen(c)).toBe(11)
  })
})

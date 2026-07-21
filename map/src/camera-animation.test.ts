import { describe, expect, it } from 'vitest'
import {
  CameraAnimator,
  cubicBezierEase,
  makeFlyPath,
  shortestBearingDelta,
  shortestLonDelta,
  type CameraAnimHost,
  type CameraTarget,
  type RawCameraSnapshot,
} from './camera-animation'
import { lonLatToMercator } from '@xgis/geo'

// Camera animation (#1256) — the easeTo/flyTo transition math + driver.
// These pin the properties a reviewer can't eyeball off a screenshot: the
// vWN path boundary/monotonicity, wrap-shortest interpolation, external-
// move cancellation, and — the load-bearing invariant — a TERMINAL frame
// bit-identical to a direct jumpTo(target).

const T = (lon: number, lat: number, zoom: number, bearing = 0, pitch = 0): CameraTarget => ({
  lon,
  lat,
  zoom,
  bearing,
  pitch,
})

/** Host stub: records jumpTo calls and derives a raw snapshot the way the
 *  real camera would (Mercator centre from lon/lat), so the animator's
 *  external-move detector exercises real round-tripping. */
function stubHost(): CameraAnimHost & { calls: Parameters<CameraAnimHost['jumpTo']>[0][] } {
  const calls: Parameters<CameraAnimHost['jumpTo']>[0][] = []
  let last: RawCameraSnapshot = { cx: 0, cy: 0, z: 0, b: 0, p: 0 }
  return {
    calls,
    jumpTo(o) {
      calls.push(o)
      const [mx, my] = lonLatToMercator(o.center[0], o.center[1])
      last = { cx: mx, cy: my, z: o.zoom, b: o.bearing, p: o.pitch }
    },
    readRaw: () => last,
  }
}

describe('shortest deltas', () => {
  it('longitude picks the wrap-shortest direction', () => {
    expect(shortestLonDelta(170, -170)).toBeCloseTo(20, 10) // +20, not -340
    expect(shortestLonDelta(-170, 170)).toBeCloseTo(-20, 10)
    expect(shortestLonDelta(0, 180)).toBeCloseTo(180, 10)
    expect(shortestLonDelta(10, 10)).toBe(0)
  })
  it('bearing wraps the same way', () => {
    expect(shortestBearingDelta(350, 10)).toBeCloseTo(20, 10)
    expect(shortestBearingDelta(10, 350)).toBeCloseTo(-20, 10)
  })
})

describe('cubicBezierEase', () => {
  const ease = cubicBezierEase(0.25, 0.1, 0.25, 1)
  it('pins the endpoints exactly', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-0.5)).toBe(0)
    expect(ease(2)).toBe(1)
  })
  it('is monotonic non-decreasing across the unit interval', () => {
    let prev = -Infinity
    for (let i = 0; i <= 100; i++) {
      const y = ease(i / 100)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })
  it('an ease-out curve sits above the diagonal mid-way', () => {
    expect(ease(0.5)).toBeGreaterThan(0.5)
  })
})

describe('makeFlyPath (van Wijk–Nuij)', () => {
  it('degenerate ground track is pure exponential zoom (u≡0)', () => {
    const p = makeFlyPath(1000, 250, 0, 1.42) // zoom in 2 levels in place
    expect(p.S).toBeGreaterThan(0)
    expect(p.u(0)).toBe(0)
    expect(p.u(p.S)).toBe(0)
    expect(p.w(0)).toBeCloseTo(1000, 6)
    expect(p.w(p.S)).toBeCloseTo(250, 6)
  })

  it('with a ground track: u runs 0→u1 monotonically and w returns to w1', () => {
    const w0 = 1000
    const w1 = 500
    const u1 = 4000
    const p = makeFlyPath(w0, w1, u1, 1.42)
    expect(p.S).toBeGreaterThan(0)
    expect(p.u(0)).toBeCloseTo(0, 6)
    expect(p.u(p.S)).toBeCloseTo(u1, 4)
    expect(p.w(0)).toBeCloseTo(w0, 4)
    expect(p.w(p.S)).toBeCloseTo(w1, 4)
    // u monotonic increasing
    let prev = -Infinity
    for (let i = 0; i <= 50; i++) {
      const u = p.u((p.S * i) / 50)
      expect(u).toBeGreaterThanOrEqual(prev - 1e-6)
      prev = u
    }
    // w rises above both endpoints somewhere in the middle (zoom-out arc)
    const wmid = p.w(p.S * 0.5)
    expect(wmid).toBeGreaterThan(Math.max(w0, w1) - 1e-6)
  })
})

describe('CameraAnimator.easeTo', () => {
  it('samples midway between endpoints and lands EXACTLY on target (≡ jumpTo)', () => {
    const anim = new CameraAnimator()
    const host = stubHost()
    const start = T(0, 0, 4)
    const target = T(20, 40, 8, 90, 30)
    anim.easeTo(start, target, 300, (t) => t, 1000) // linear ease for arithmetic
    anim.tick(1150, host) // t = 0.5
    const mid = host.calls[0]!
    expect(mid.center[0]).toBeCloseTo(10, 6) // lon linear
    expect(mid.zoom).toBeCloseTo(6, 6)
    expect(mid.bearing).toBeCloseTo(45, 6)
    expect(mid.pitch).toBeCloseTo(15, 6)
    // latitude is linear in MERCATOR-Y, not degrees → strictly between
    expect(mid.center[1]).toBeGreaterThan(0)
    expect(mid.center[1]).toBeLessThan(40)
    expect(anim.isActive()).toBe(true)

    anim.tick(1300, host) // t = 1 → terminal
    const last = host.calls[host.calls.length - 1]!
    expect(last.center).toEqual([target.lon, target.lat])
    expect(last.zoom).toBe(target.zoom)
    expect(last.bearing).toBe(target.bearing)
    expect(last.pitch).toBe(target.pitch)
    expect(anim.isActive()).toBe(false)
  })

  it('an external camera write between ticks cancels the animation', () => {
    const anim = new CameraAnimator()
    const host = stubHost()
    anim.easeTo(T(0, 0, 4), T(40, 0, 4), 300, (t) => t, 0)
    anim.tick(150, host) // applies + records expected raw
    const nBefore = host.calls.length
    // Simulate a user gesture: mutate the host's raw snapshot out from under it.
    ;(host as unknown as { readRaw: () => RawCameraSnapshot }).readRaw = () => ({
      cx: 99999,
      cy: 0,
      z: 4,
      b: 0,
      p: 0,
    })
    anim.tick(225, host)
    expect(anim.isActive()).toBe(false)
    expect(host.calls.length).toBe(nBefore) // no further jumpTo after cancel
  })
})

describe('CameraAnimator.flyTo', () => {
  it('resolves a positive duration and lands EXACTLY on target', () => {
    const anim = new CameraAnimator()
    const host = stubHost()
    const start = T(0, 0, 3)
    const target = T(120, 35, 6)
    const dur = anim.flyTo(start, target, {}, 1000, 0)
    expect(dur).toBeGreaterThan(0)
    // A mid frame is genuinely intermediate (neither endpoint).
    anim.tick(dur * 0.5, host)
    const mid = host.calls[0]!
    expect(mid.center[0]).toBeGreaterThan(0)
    expect(mid.center[0]).toBeLessThan(120)
    anim.tick(dur, host) // terminal
    const last = host.calls[host.calls.length - 1]!
    expect(last.center).toEqual([target.lon, target.lat])
    expect(last.zoom).toBe(6)
    expect(anim.isActive()).toBe(false)
  })

  it('explicit duration overrides the speed-derived one', () => {
    const anim = new CameraAnimator()
    const dur = anim.flyTo(T(0, 0, 3), T(50, 0, 5), { durationMs: 800 }, 1000, 0)
    expect(dur).toBe(800)
  })

  it('a no-op flight (same camera) returns 0 duration', () => {
    const anim = new CameraAnimator()
    const dur = anim.flyTo(T(10, 20, 5), T(10, 20, 5), {}, 1000, 0)
    expect(dur).toBe(0)
    expect(anim.isActive()).toBe(false)
  })
})

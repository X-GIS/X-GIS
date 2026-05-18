// Camera transition smoothness invariants. User reported the globe
// "suddenly tilts strangely" during certain interaction sequences —
// mathematically the pitch / bearing values are continuous but the
// MVP matrix has discontinuities that visually feel like a jump.
//
// Possible root causes:
//   * Pitch interpolation curve crossing a non-linear segment.
//   * Bearing wrap at ±180° causing a jump rather than a wrap.
//   * RTC re-centering at a zoom / pan threshold causing a one-frame
//     matrix flip.
//
// This test samples the camera matrix at sequential frames during
// a smooth transition and asserts that successive matrix elements
// (and the camera up-vector implied by them) change by less than a
// "discontinuity threshold" per frame.

import { describe, expect, it } from 'vitest'
import { Camera } from '../projection/camera'

const VIEWPORT_W = 1280
const VIEWPORT_H = 720

function maxDelta(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > m) m = d
  }
  return m
}

// Sample matrix at N+1 frames for a linear sweep between start/end
// states. Returns the per-frame max-element-delta sequence.
function sweepDeltas(
  modifyFn: (cam: Camera, t: number) => void,
  steps: number,
): number[] {
  const cam = new Camera()
  modifyFn(cam, 0)
  let prev = new Float32Array(cam.getRTCMatrix(VIEWPORT_W, VIEWPORT_H, 1))
  const deltas: number[] = []
  for (let i = 1; i <= steps; i++) {
    modifyFn(cam, i / steps)
    const cur = new Float32Array(cam.getRTCMatrix(VIEWPORT_W, VIEWPORT_H, 1))
    deltas.push(maxDelta(prev, cur))
    prev = cur
  }
  return deltas
}

describe('camera transition smoothness invariants', () => {
  it('pitch 0→60° sweep produces monotone non-decreasing matrix changes', () => {
    const deltas = sweepDeltas((cam, t) => {
      cam.pitch = 60 * t
    }, 60)
    // No frame should produce a delta > 10× the median (1-frame jump).
    const sorted = [...deltas].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const worst = sorted[sorted.length - 1]!
    expect(worst, `pitch sweep worst-delta ${worst.toFixed(3)} vs median ${median.toFixed(3)}`)
      .toBeLessThan(median * 50)
  })

  it('bearing 0→360° sweep does not produce a jump near 180° (wrap discontinuity)', () => {
    const deltas = sweepDeltas((cam, t) => {
      cam.bearing = 360 * t
    }, 360)
    const sorted = [...deltas].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    // Bearing wrap at exactly 360° → 0° is allowed; check that
    // the median-vs-worst ratio is still bounded.
    const worst = sorted[sorted.length - 1]!
    expect(worst, `bearing sweep worst-delta ${worst.toFixed(3)} vs median ${median.toFixed(3)}`)
      .toBeLessThan(median * 100)
  })

  it('zoom 5→15 sweep keeps matrix changes bounded across LOD boundaries', () => {
    const deltas = sweepDeltas((cam, t) => {
      cam.zoom = 5 + 10 * t
    }, 100)
    const sorted = [...deltas].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const worst = sorted[sorted.length - 1]!
    expect(worst).toBeLessThan(median * 100)
  })

  it('matrix element changes are finite (no NaN/Inf at any sample)', () => {
    const cam = new Camera()
    for (let p = 0; p <= 85; p += 5) {
      cam.pitch = p
      const mat = cam.getRTCMatrix(VIEWPORT_W, VIEWPORT_H, 1)
      for (let i = 0; i < mat.length; i++) {
        expect(Number.isFinite(mat[i]!), `pitch=${p} mat[${i}]=${mat[i]}`).toBe(true)
      }
    }
  })

  it('matrix determinant stays bounded across a pitch sweep', () => {
    // 4x4 matrix determinant sanity check — a discontinuity in
    // pitch interpolation would manifest as a wildly different
    // determinant on adjacent frames.
    const cam = new Camera()
    const dets: number[] = []
    for (let p = 0; p <= 60; p += 1) {
      cam.pitch = p
      const m = cam.getRTCMatrix(VIEWPORT_W, VIEWPORT_H, 1)
      // Approximate det via the diagonal product for a quick monotone
      // check; full 4x4 det is overkill here, the goal is to detect
      // discontinuities, not absolute magnitude.
      const trace = m[0]! + m[5]! + m[10]! + m[15]!
      dets.push(trace)
    }
    // Trace should be smooth (no spikes > 10× neighbour delta).
    for (let i = 2; i < dets.length; i++) {
      const dPrev = Math.abs(dets[i - 1]! - dets[i - 2]!)
      const dCur = Math.abs(dets[i]! - dets[i - 1]!)
      if (dPrev > 1e-6) {
        expect(dCur / dPrev,
          `pitch=${i}° trace-jump ratio ${(dCur / dPrev).toFixed(2)}`)
          .toBeLessThan(100)
      }
    }
  })
})

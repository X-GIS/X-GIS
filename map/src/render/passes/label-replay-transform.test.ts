// ═══ #1177 — S16 replay-correction solve: exactness proof + fallbacks ═══
//
// The module claims (see label-replay-transform.ts header): for a flat
// projection at pitch 0 with fixed bearing, the solved similarity maps the
// PREPARED frame's projection of EVERY point exactly onto the CURRENT
// frame's. These tests instantiate that proof two ways:
//   1. against a synthetic similarity projector (pure math, any bearing), and
//   2. against the REAL makeLabelProjectors flat-Mercator path (the exact
//      code the label pass wires the solve to), with hand-built pitch-0 MVPs.
// Plus the defensive-band fallbacks (null projection, degenerate refs,
// out-of-band scale/shift) that keep a failed solve at identity replay.

import { describe, it, expect } from 'vitest'
import { WORLD_MERC } from '@xgis/geo'
import {
  sampleReplayRefs,
  solveReplayTransform,
  REPLAY_REFS_LEN,
  type LabelReplayTransform,
  type MercProjector,
} from './label-replay-transform'
import { makeLabelProjectors } from '../../render-loop-helpers'

/** Synthetic pitch-0 camera: screen = C + (1/mpp)·R(θ)·F·(merc − c), F = y-flip
 *  (screen y grows downward while merc y grows northward) — the P(x) of the
 *  module-header proof. */
function similarityProjector(
  mpp: number,
  cx: number,
  cy: number,
  bearingRad: number,
  screenCx = 400,
  screenCy = 300,
): MercProjector {
  const cos = Math.cos(bearingRad)
  const sin = Math.sin(bearingRad)
  return (sx: number, sy: number) => {
    const rx = sx - cx
    const ry = -(sy - cy) // F: merc north → screen up
    return [screenCx + (cos * rx - sin * ry) / mpp, screenCy + (sin * rx + cos * ry) / mpp] as const
  }
}

/** Real-path helper: pitch-0 bearing-θ flat-Mercator MVP for makeLabelProjectors
 *  (mirrors projectMerc's element usage: ndcX from [0]/[4]/[12], ndcY from
 *  [1]/[5]/[13], w from [3]/[7]/[15]; pitch 0 ⇒ w ≡ 1). */
function flatMercProjector(
  mpp: number,
  ccx: number,
  ccy: number,
  bearingRad: number,
  w: number,
  h: number,
): MercProjector {
  const mvp = new Float32Array(16)
  const cos = Math.cos(bearingRad)
  const sin = Math.sin(bearingRad)
  mvp[0] = (2 * cos) / (w * mpp)
  mvp[4] = (-2 * sin) / (w * mpp)
  mvp[1] = (2 * sin) / (h * mpp)
  mvp[5] = (2 * cos) / (h * mpp)
  mvp[15] = 1
  const { projectMercAny } = makeLabelProjectors(mvp, w, h, {
    projType: 0,
    ccx,
    ccy,
    centerLon: 0,
    centerLat: 0,
    visibleWorldCopies: [0],
  })
  return projectMercAny
}

const freshOut = (): LabelReplayTransform => ({ scale: 1, dx: 0, dy: 0 })

describe('solveReplayTransform — exactness proof (similarity projector)', () => {
  it('maps EVERY prepared-frame point exactly onto the current frame (zoom + pan + bearing)', () => {
    const mpp0 = 10
    const mpp1 = 10 / 2 ** 0.15 // the S16 tolerance edge
    for (const bearing of [0, (37 * Math.PI) / 180]) {
      const P0 = similarityProjector(mpp0, 1000, 2000, bearing)
      const P1 = similarityProjector(mpp1, 1000 + 48 * mpp1, 2000 - 30 * mpp1, bearing)
      const refs = new Float64Array(REPLAY_REFS_LEN)
      expect(sampleReplayRefs(P0, 1000, 2000, mpp0, 150, refs)).toBe(true)
      const out = freshOut()
      expect(solveReplayTransform(refs, P1, out)).toBe(true)
      expect(out.scale).toBeCloseTo(mpp0 / mpp1, 9)
      // The proof quantifies over ALL anchors, not just the refs — check a
      // spread of arbitrary merc points far from the reference triangle.
      for (const [mx, my] of [
        [0, 0],
        [-5000, 12000],
        [987.65, -4321.9],
        [20000, 20000],
      ] as const) {
        const p = P0(mx, my)!
        const px = p[0]
        const py = p[1]
        const q = P1(mx, my)!
        expect(out.scale * px + out.dx).toBeCloseTo(q[0], 6)
        expect(out.scale * py + out.dy).toBeCloseTo(q[1], 6)
      }
    }
  })

  it('solves identity (scale 1, shift 0) when the camera has not moved', () => {
    const P = similarityProjector(5, -3000, 800, 0.3)
    const refs = new Float64Array(REPLAY_REFS_LEN)
    expect(sampleReplayRefs(P, -3000, 800, 5, 100, refs)).toBe(true)
    const out = freshOut()
    expect(solveReplayTransform(refs, P, out)).toBe(true)
    expect(out.scale).toBeCloseTo(1, 12)
    expect(out.dx).toBeCloseTo(0, 9)
    expect(out.dy).toBeCloseTo(0, 9)
  })
})

describe('solveReplayTransform — real makeLabelProjectors flat-Mercator path', () => {
  it('is exact through the production projector at pitch 0 (bearing 30°)', () => {
    const w = 800
    const h = 600
    const bearing = (30 * Math.PI) / 180
    const mpp0 = 20
    const mpp1 = 20 / 2 ** 0.12
    const c0: [number, number] = [120000, -45000]
    // 40 px of centre drift at the current scale — inside the S16 tolerance.
    const c1: [number, number] = [c0[0] + 40 * mpp1, c0[1] + 25 * mpp1]
    const P0 = flatMercProjector(mpp0, c0[0], c0[1], bearing, w, h)
    const P1 = flatMercProjector(mpp1, c1[0], c1[1], bearing, w, h)
    const refs = new Float64Array(REPLAY_REFS_LEN)
    expect(sampleReplayRefs(P0, c0[0], c0[1], mpp0, Math.min(w, h) / 4, refs)).toBe(true)
    const out = freshOut()
    expect(solveReplayTransform(refs, P1, out)).toBe(true)
    expect(out.scale).toBeCloseTo(mpp0 / mpp1, 5)
    // Arbitrary on-screen anchors (well inside the ±1.5-NDC projector gate in
    // BOTH cameras). MVP entries are Float32 — tolerance 1e-3 px, far below
    // any visible error yet far above f32 noise.
    for (const [dxm, dym] of [
      [0, 0],
      [1500, -2200],
      [-3100, 900],
      [2500, 2500],
    ] as const) {
      const mx = c0[0] + dxm
      const my = c0[1] + dym
      const p = P0(mx, my)
      const q = P1(mx, my)
      expect(p).not.toBeNull()
      expect(q).not.toBeNull()
      const px = p![0]
      const py = p![1]
      expect(out.scale * px + out.dx).toBeCloseTo(q![0], 3)
      expect(out.scale * py + out.dy).toBeCloseTo(q![1], 3)
    }
  })
})

describe('sampleReplayRefs — reference geometry', () => {
  it('points offsets toward the origin near the antimeridian / poles', () => {
    const P: MercProjector = () => [0, 0] as const
    const refs = new Float64Array(REPLAY_REFS_LEN)
    const cx = 0.49 * WORLD_MERC
    const cy = 0.49 * WORLD_MERC
    expect(sampleReplayRefs(P, cx, cy, 10, 100, refs)).toBe(true)
    expect(refs[4]!).toBeLessThan(cx) // +x ref stepped inward
    expect(refs[9]!).toBeLessThan(cy) // +y ref stepped inward
  })

  it('rejects degenerate inputs (mpp/refDist ≤ 0) and failed projections', () => {
    const refs = new Float64Array(REPLAY_REFS_LEN)
    const P: MercProjector = () => [0, 0] as const
    expect(sampleReplayRefs(P, 0, 0, 0, 100, refs)).toBe(false)
    expect(sampleReplayRefs(P, 0, 0, 10, 0, refs)).toBe(false)
    const nullP: MercProjector = () => null
    expect(sampleReplayRefs(nullP, 0, 0, 10, 100, refs)).toBe(false)
  })
})

describe('solveReplayTransform — defensive-band fallbacks (identity replay)', () => {
  const preparedRefs = (): Float64Array => {
    const refs = new Float64Array(REPLAY_REFS_LEN)
    const P0 = similarityProjector(10, 0, 0, 0)
    expect(sampleReplayRefs(P0, 0, 0, 10, 100, refs)).toBe(true)
    return refs
  }

  it('fails when the current projector culls a reference point', () => {
    const refs = preparedRefs()
    expect(solveReplayTransform(refs, () => null, freshOut())).toBe(false)
  })

  it('fails outside the scale band (e.g. a 10× jump no tolerance window allows)', () => {
    const refs = preparedRefs()
    const P1 = similarityProjector(1, 0, 0, 0) // mpp 10 → 1: scale 10 ≫ band max 4
    expect(solveReplayTransform(refs, P1, freshOut())).toBe(false)
  })

  it('fails outside the shift band (world-copy-flip magnitude)', () => {
    const refs = preparedRefs()
    const P1 = similarityProjector(10, 500000, 0, 0) // 50 000 px shift ≫ band 8192
    expect(solveReplayTransform(refs, P1, freshOut())).toBe(false)
  })

  it('fails on degenerate stored refs (zero spread)', () => {
    const refs = new Float64Array(REPLAY_REFS_LEN) // all zeros: d1 = d2 = 0
    const P1 = similarityProjector(10, 0, 0, 0)
    expect(solveReplayTransform(refs, P1, freshOut())).toBe(false)
  })
})

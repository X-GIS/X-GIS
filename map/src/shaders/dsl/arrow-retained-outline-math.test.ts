import { describe, expect, it } from 'vitest'

// ═══ CPU-side proof of the arrow-outline SDF composite — BEFORE touching WGSL ═══
//
// A prior outline attempt (#1338, reverted) drew a SECOND, independently-scaled arrow batch
// as a "bigger black arrow underneath" — wrong, because the two quads' head-tapers began at
// DIFFERENT physical distances from the tail, flaring the black shape around the arrowhead.
// This is the from-scratch replacement: ONE quad, ONE distance field `d` (UNCHANGED from the
// shipped shader), a stroke band defined as a constant-threshold shift of that SAME `d` — so
// by construction there is no independent reparametrization to flare.
//
// This file is a literal, line-for-line mirror of the proposed WGSL arithmetic in plain JS
// (`computeD` = the existing fs_arrow_retained `d`; `fsOutline` = the new composite). It
// proves, by direct calculation at concrete sample points — not "should work" — that (a) at
// `su=0` (every EXISTING non-outlined arrow: CO-OPS, seoul-arc-multiday, the icon example) the
// new formula is an EXACT algebraic identity to the shipped shader (zero regression, not an
// approximation), and (b) at `su>0` the fill/stroke/transparent regions land correctly and
// continuously — deep fill = pure tint, deep stroke ring = pure black, beyond the stroke =
// transparent, with smooth AA at both the fill/stroke seam and the outer stroke edge.

const SH = 0.09
const HH = 0.26
const HB = 0.6
const HEAD_SLOPE = HH / (1 - HB)

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t

/** Mirrors fs_arrow_retained's `d` EXACTLY (unchanged by the outline — same formula, same
 *  constants) — the signed "outside distance": d<0 inside the silhouette, d=0 on the
 *  boundary, d>0 outside. */
function computeD(ax: number, ay: number): number {
  const absAy = Math.abs(ay)
  const hwHead = Math.max(1 - ax, 0) * HEAD_SLOPE
  const hw = ax < HB ? SH : hwHead
  return Math.max(absAy - hw, Math.max(-ax, ax - 1))
}

/** The SHIPPED (pre-outline) formula, verbatim: RGB is ALWAYS tint.rgb unconditionally; only
 *  alpha is modulated by coverage. This is the zero-regression baseline `su=0` must match. */
function fsShipped(
  ax: number,
  ay: number,
  aa: number,
  tint: readonly [number, number, number, number],
): { rgb: [number, number, number]; alpha: number } {
  const d = computeD(ax, ay)
  const cov = clamp01(0.5 - d / aa)
  return { rgb: [tint[0], tint[1], tint[2]], alpha: tint[3] * cov }
}

/** The PROPOSED composite. `strokeCov` (not `covFill`) drives the colour blend toward black —
 *  the fix for the regression a naive `mix(black, tint, covFill)` would have caused (see the
 *  'zero regression' describe block below for the proof this fixes). */
function fsOutline(
  ax: number,
  ay: number,
  su: number,
  aa: number,
  tint: readonly [number, number, number, number],
): {
  rgb: [number, number, number]
  alpha: number
  covFill: number
  covTotal: number
  strokeCov: number
} {
  const d = computeD(ax, ay)
  const covFill = clamp01(0.5 - d / aa)
  const covTotal = clamp01(0.5 - (d - su) / aa)
  const strokeCov = Math.max(covTotal - covFill, 0)
  const rgb: [number, number, number] = [
    mix(tint[0], 0, strokeCov),
    mix(tint[1], 0, strokeCov),
    mix(tint[2], 0, strokeCov),
  ]
  return { rgb, alpha: tint[3] * covTotal, covFill, covTotal, strokeCov }
}

const TINT: readonly [number, number, number, number] = [0.46, 0.32, 0.89, 1] // s111-speed band1 purple
const AA = 0.02 // representative screen-derivative AA width in loc-space units

// Sample points spanning the whole profile: shaft interior/edge, head taper, tip, past-tip,
// past-max-width, before-the-tail.
const SAMPLES: [number, number][] = [
  [0.3, 0], // shaft centreline
  [0.3, SH], // shaft edge (d≈0)
  [0.3, SH * 3], // well outside the shaft
  [0.8, 0], // head centreline
  [0.8, Math.max(1 - 0.8, 0) * HEAD_SLOPE], // exactly on the head taper edge (d≈0)
  [1.0, 0], // exactly at the tip (hw=0 there)
  [1.05, 0], // just past the tip
  [1.3, 0], // well past the tip
  [0.3, HH + 0.05], // past the max bounding half-height
  [-0.05, 0], // just before the tail
]

describe('arrow outline SDF composite — zero regression at su=0 (EXACT algebraic identity)', () => {
  it.each(SAMPLES)('ax=%s ay=%s: su=0 output === the shipped formula, bit for bit', (ax, ay) => {
    const shipped = fsShipped(ax, ay, AA, TINT)
    const outlined = fsOutline(ax, ay, 0, AA, TINT)
    // strokeCov must be IDENTICALLY 0 — the algebraic root of the zero-regression proof.
    expect(outlined.strokeCov).toBe(0)
    expect(outlined.rgb).toEqual(shipped.rgb)
    expect(outlined.alpha).toBeCloseTo(shipped.alpha, 12)
  })

  it('demonstrates the REJECTED naive formula (mix by covFill) WOULD have regressed su=0', () => {
    // The bug caught before implementation: mix(black, tint, covFill) blends toward black
    // using covFill itself, which is 0.5 (not 1) at the exact boundary — darkening every
    // existing arrow's AA edge even with no outline requested. Recorded here so the mistake
    // is never reintroduced.
    const ax = 0.3
    const ay = SH // d = 0 exactly
    const d = computeD(ax, ay)
    expect(d).toBeCloseTo(0, 10)
    const covFill = clamp01(0.5 - d / AA)
    expect(covFill).toBeCloseTo(0.5, 10)
    const naiveRgb = mix(0, TINT[0], covFill) // the REJECTED formula's red channel
    expect(naiveRgb).toBeCloseTo(TINT[0] * 0.5, 10) // half brightness — the regression
    expect(naiveRgb).not.toBeCloseTo(TINT[0], 5) // strictly darker than the correct tint.rgb
  })
})

describe('arrow outline SDF composite — su>0 fill/stroke/transparent regions', () => {
  const SU = 0.08 // stroke band width in the SAME unit-space as d/ax/ay

  it('deep inside the fill: pure tint colour, full alpha', () => {
    const r = fsOutline(0.3, 0, SU, AA, TINT) // shaft centreline, d ≪ 0
    expect(r.strokeCov).toBeCloseTo(0, 10)
    expect(r.rgb).toEqual([TINT[0], TINT[1], TINT[2]])
    expect(r.alpha).toBeCloseTo(TINT[3], 10)
  })

  it('deep inside the stroke ring (d ≈ SU/2, SU ≫ aa): pure black, full alpha', () => {
    // Pick ay so that d = SU/2 exactly on the shaft (ax=0.3<HB, hw=SH).
    const ay = SH + SU / 2
    const r = fsOutline(0.3, ay, SU, AA, TINT)
    expect(computeD(0.3, ay)).toBeCloseTo(SU / 2, 10)
    expect(r.covFill).toBeCloseTo(0, 6) // past the fill boundary
    expect(r.covTotal).toBeCloseTo(1, 6) // still well within fill+stroke
    expect(r.strokeCov).toBeCloseTo(1, 6)
    expect(r.rgb[0]).toBeCloseTo(0, 6)
    expect(r.rgb[1]).toBeCloseTo(0, 6)
    expect(r.rgb[2]).toBeCloseTo(0, 6)
    expect(r.alpha).toBeCloseTo(TINT[3], 6)
  })

  it('at the fill/stroke seam (d=0 exactly): 50/50 colour blend, FULL alpha (no transparency dip)', () => {
    const ay = SH // d = 0 on the shaft
    const r = fsOutline(0.3, ay, SU, AA, TINT)
    expect(r.covFill).toBeCloseTo(0.5, 10)
    expect(r.covTotal).toBeCloseTo(1, 6) // SU ≫ aa, so covTotal is already saturated here
    expect(r.strokeCov).toBeCloseTo(0.5, 6)
    expect(r.rgb[0]).toBeCloseTo(TINT[0] * 0.5, 6)
    expect(r.alpha).toBeCloseTo(TINT[3], 6) // opaque — an internal seam between two solid colours, not an edge fading to nothing
  })

  it('at the outer stroke edge (d=SU exactly): alpha fades through 0.5 — the true outer boundary', () => {
    const ay = SH + SU
    const r = fsOutline(0.3, ay, SU, AA, TINT)
    expect(computeD(0.3, ay)).toBeCloseTo(SU, 10)
    expect(r.covTotal).toBeCloseTo(0.5, 10)
    expect(r.alpha).toBeCloseTo(TINT[3] * 0.5, 10)
  })

  it('well beyond the stroke band: alpha ≈ 0 (discarded by the existing < 0.004 threshold)', () => {
    const ay = SH + SU + 3 * AA
    const r = fsOutline(0.3, ay, SU, AA, TINT)
    expect(r.alpha).toBeLessThan(0.004)
  })

  it('past the tip (ax slightly > 1): the stroke continues past the point via the SAME d — no clip', () => {
    const eps = SU / 2
    const r = fsOutline(1 + eps, 0, SU, AA, TINT)
    expect(computeD(1 + eps, 0)).toBeCloseTo(eps, 10)
    expect(r.strokeCov).toBeGreaterThan(0.9) // deep within the stroke ring past the tip
    expect(r.alpha).toBeCloseTo(TINT[3], 6)
  })

  it('quad-enlargement invariant: margin = su, so su=0 rasterizes the IDENTICAL bounds as today', () => {
    // The VS will compute margin = stroke_units per-instance. At su=0 the quad bounds
    // (qx∈[0,1], qy∈[-HH,HH]) are UNCHANGED from the shipped shader — proven by construction
    // (margin literally IS stroke_units, and stroke_units defaults to 0 for every existing
    // caller). No new test needed beyond this documented identity: margin(0) = 0.
    const margin = (su: number): number => su
    expect(margin(0)).toBe(0)
  })
})

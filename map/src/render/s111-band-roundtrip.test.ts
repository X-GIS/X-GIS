// ═══ #1450 C — the two colour authorities, measured once ═══
//
// THE QUESTION THE EPIC ASKED, unchanged by everything else that moved under it:
//
//   the static portrayal picks a band from the coverage's RAW `speed[]`;
//   the advected one picks it from `length(f16(u/peak), f16(v/peak))` — the velocity pair as it
//   survives the r16float textures — so near a band edge the round-trip can flip the band.
//
// If the static path is ever retired the advected one becomes the sole colour authority, and a
// flip is a chart reporting the wrong speed band. So the disagreement has to be a NUMBER before
// anyone decides whether it needs closing.
//
// #1450 specified this as a render measurement, with the static portrayal as a per-pixel colour
// oracle. It does not need one: the disagreement is entirely a property of the f16 round-trip
// against the band edges, so it can be swept on the CPU — EXHAUSTIVELY rather than sampled, over
// the whole (speed × direction × peak) domain, at a fraction of the cost. That also makes it a
// regression gate rather than a one-off report.
//
// ── WHAT IS ASSERTED, AND WHY IT IS NOT A RATE ────────────────────────────────────────────────
//
// A disagreement RATE is the wrong shape: it depends on how the sweep is sampled, so it measures
// the test as much as the code, and any bound on it is a number to nudge. The property that
// actually matters is STRUCTURAL — a flip may only happen to a speed that is already within the
// round-trip's own resolution of an edge. A cell a knot away from an edge must never flip, at any
// direction, at any peak. That distinguishes "f16 is grainy near a threshold", which is inherent
// and harmless, from "the band decision is wrong", which is a defect.

import { describe, it, expect } from 'vitest'
import { f32ToF16 } from './material/coverage-material'
import { s111BandTable, s111BandTableNormalized } from './s111-portrayal'
import { S111_BAND_COUNT, S111_BAND_STRIDE } from '../shaders/dsl/s111-band-table-layout'

/** f16 bits → the f32 the GPU widens them to. The inverse of `f32ToF16`, which the packer uses;
 *  together they are exactly what a value suffers on its way through an r16float texture. */
function f16ToF32(h: number): number {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  const sign = s ? -1 : 1
  if (e === 0) return sign * 2 ** -14 * (f / 1024)
  if (e === 0x1f) return f ? NaN : sign * Infinity
  return sign * 2 ** (e - 15) * (1 + f / 1024)
}

/** The band a speed lands in, by the SAME rule the shader runs: walk the edges, take the last one
 *  the speed is not below. Row `i` is catalogue band `i+1`; the ninth has a finite sentinel edge
 *  standing in for `geSemiInterval`. */
function bandOf(speed: number, edges: readonly number[]): number {
  let b = 0
  for (let i = 0; i < S111_BAND_COUNT; i++) if (!(speed < edges[i]!)) b = i + 1
  return Math.min(b, S111_BAND_COUNT - 1)
}

const KNOT_EDGES = (() => {
  const t = s111BandTable()
  return Array.from({ length: S111_BAND_COUNT }, (_, b) => t[b * S111_BAND_STRIDE]!)
})()

/** What the shader sees for a cell of true speed `s` heading `dirDeg`, through the packer's own
 *  normalization and the r16float textures. Mirrors `packFlowFieldUV` exactly — normalize by the
 *  field's peak FIRST, then round each component. */
function shaderSpeedNorm(s: number, dirDeg: number, peak: number): number {
  const rad = (dirDeg * Math.PI) / 180
  const n = s / peak
  const u = f16ToF32(f32ToF16(n * Math.sin(rad)))
  const v = f16ToF32(f32ToF16(n * Math.cos(rad)))
  return Math.hypot(u, v)
}

/** Normalized edges as the shader actually holds them — read out of the uploaded table, not
 *  recomputed, so a change to how the table is built is a change this measurement sees. */
function normEdges(peak: number): number[] {
  const t = s111BandTableNormalized(peak, 1)
  return Array.from({ length: S111_BAND_COUNT }, (_, b) => t[b * S111_BAND_STRIDE]!)
}

describe('#1450 C — the f16 round-trip against the band edges', () => {
  // Peaks spanning what a real field carries: a calm tidal cell, the demo fixture's 1.9 kn, a
  // strong tidal race, and an ocean-current outlier. The peak matters because everything is
  // normalized by it — a large peak pushes a slow cell's components toward f16's denormals.
  const PEAKS = [1.0, 1.9038296, 6, 20]

  it('a flip only ever happens within the round-trip’s own resolution of an edge', () => {
    // THE CLAIM. Exhaustive over direction at 1°, and over speed at a step fine enough to resolve
    // the f16 quantum near every edge. What is recorded is the WORST distance from an edge at
    // which any flip occurred — if that is comparable to the f16 quantum, the disagreement is the
    // round-trip's inherent graininess at a threshold and nothing more.
    let worstAbs = 0
    let worstRel = 0
    let flips = 0
    let total = 0
    const worstAt: { peak: number; speed: number; dir: number; edge: number }[] = []

    for (const peak of PEAKS) {
      const ne = normEdges(peak)
      for (const edge of KNOT_EDGES) {
        if (!Number.isFinite(edge) || edge > peak) continue // an edge above the peak is unreachable
        // ±2 % of the peak around the edge, at 1/4000 of the peak — ~4× finer than the f16 quantum
        // at these magnitudes, so no flip can hide between two samples.
        const span = peak * 0.02
        const step = peak / 4000
        for (let s = Math.max(0, edge - span); s <= edge + span; s += step) {
          for (let dir = 0; dir < 360; dir += 1) {
            total++
            const cpu = bandOf(s, KNOT_EDGES)
            const gpu = bandOf(shaderSpeedNorm(s, dir, peak), ne)
            if (cpu === gpu) continue
            flips++
            const d = Math.abs(s - edge)
            if (d > worstAbs) {
              worstAbs = d
              worstAt.length = 0
              worstAt.push({ peak, speed: s, dir, edge })
            }
            worstRel = Math.max(worstRel, d / peak)
          }
        }
      }
    }

    const w = worstAt[0]
    // The rate is printed for context only and is NOT a field-wide figure: the sweep is
    // deliberately concentrated in a ±2 % band around each edge, which is where flips live by
    // construction. The load-bearing number is the WORST DISTANCE.
    console.log(
      `[s111-band-roundtrip] worst flip distance from an edge: ${worstAbs.toExponential(3)} kn ` +
        `= ${worstRel.toExponential(3)} of the peak` +
        (w ? ` (peak ${w.peak}, speed ${w.speed.toFixed(6)}, dir ${w.dir}°, edge ${w.edge})` : '') +
        ` | ${flips}/${total} of an EDGE-CONCENTRATED sweep (not a field rate)`,
    )

    // PRECONDITION: the sweep found flips at all. A sweep that produced none would pass the claim
    // vacuously — §12's "an assertion carries information only if it DISTINGUISHES the states of
    // the thing it tests" — and would mean the sampling missed the edges entirely.
    expect(flips, 'the sweep straddles the edges').toBeGreaterThan(0)

    // …and the claim: every flip is within the round-trip's own resolution. f16 carries 11 bits of
    // mantissa, so a value normalized into [-1, 1] resolves to ~2⁻¹¹ ≈ 4.9e-4 of the peak; the
    // magnitude is recovered from TWO such components, so 2× that is the honest bound. A flip
    // further out than this is not graininess — it is the two authorities disagreeing about the
    // rule, which is the defect #1450 C was written to find.
    expect(worstRel, 'a flip further from an edge than the f16 quantum').toBeLessThan(2 ** -10)
  })

  it('…so a cell a KNOT away from any edge never changes band, at any direction or peak', () => {
    // The consequence a chart reader cares about, stated in the units the catalogue uses. This is
    // the assertion that would fail if the normalization, the packing or the table's units ever
    // drifted — a scale error shifts every band, not just the ones near an edge.
    for (const peak of PEAKS) {
      const ne = normEdges(peak)
      for (let s = 0.05; s <= peak; s += peak / 200) {
        const near = Math.min(
          ...KNOT_EDGES.filter((e) => Number.isFinite(e)).map((e) => Math.abs(s - e)),
        )
        if (near < 1) continue
        for (let dir = 0; dir < 360; dir += 7) {
          expect(
            bandOf(shaderSpeedNorm(s, dir, peak), ne),
            `peak ${peak}, speed ${s.toFixed(3)} kn, dir ${dir}° — ${near.toFixed(2)} kn from any edge`,
          ).toBe(bandOf(s, KNOT_EDGES))
        }
      }
    }
  })

  it('a CALM field is not divided by zero — the table stays in knots', () => {
    // `packFlowFieldUV` returns `scale: 0` for an all-nodata or dead-calm field, and
    // `s111BandTableNormalized` must then leave the edges in knots rather than dividing by it.
    // Nothing is symbolized at speed 0 anyway, so what matters is that the table is finite.
    for (const peak of [0, -1]) {
      for (const e of normEdges(peak)) expect(Number.isFinite(e)).toBe(true)
    }
    expect(normEdges(0)).toEqual(KNOT_EDGES)
  })
})

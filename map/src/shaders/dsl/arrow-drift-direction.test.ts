// ═══ An arrow must MOVE in the direction it POINTS (#1520) ═══
//
// Reported from S-111 Live at `#11.30/38.74143/-74.93501` and `#12.80/38.76332/-74.97529`:
// "the direction the arrow travels and the direction it faces are different."
//
// THE CAUSE, and why it hid. The displacement has to stay inside the box the two projected basis
// anchors span, or the VS extrapolates a linearization past the range it was built for. Clamping
// the two components INDEPENDENTLY keeps it inside — and TURNS it, because each component is cut
// by a different amount.
//
// It only fires when a component actually exceeds the leash. The v component carries the grid's
// `uvAspect` (a uv unit is a different true distance on each axis), so the condition is
// `phase · aspect > 1`. The synthetic demo fixture has aspect 0.24 and can NEVER reach it, which
// is why three rounds of reproduction on that fixture found nothing; a real regional cell is
// usually wider than it is tall, so it fires there and gets worse as an arrow ages.
//
// The fix is to fit by SCALING both components by one factor — Chebyshev, matching the leash the
// excursion was bounded by — so the direction is untouched.
//
// This file tests the FIT RULE, which is pure arithmetic over the aspect, and pins the shader to
// its shape. The angle it measures is the one a viewer sees: between the displacement and the
// vector the glyph is rotated by.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl } from './arrow-retained'

/** The two candidate ways to keep a displacement inside the leash box. */
const fitPerAxis = (kx: number, ky: number): [number, number] => [
  Math.max(-1, Math.min(1, kx)),
  Math.max(-1, Math.min(1, ky)),
]
const fitUniform = (kx: number, ky: number): [number, number] => {
  const m = Math.max(Math.abs(kx), Math.abs(ky))
  const f = m > 1 ? 1 / m : 1
  return [kx * f, ky * f]
}

/** Angle in degrees between the displacement and the glyph's own direction. Both are expressed
 *  in the SAME uv terms the VS uses — the drift steps `(vu, −vv·aspect)` and the glyph is rotated
 *  by `(vu, −vv·aspect)`, so any angle between them comes from the fit and nothing else. */
function misalignmentDeg(
  aspect: number,
  phase: number,
  fit: (kx: number, ky: number) => [number, number],
): number {
  const vu = 0.4
  const vv = 0.9 // a NNE current
  const [kx, ky] = fit(vu * phase, -vv * phase * aspect)
  const gx = vu
  const gy = -vv * aspect
  const cos = (kx * gx + ky * gy) / (Math.hypot(kx, ky) * Math.hypot(gx, gy) || Number.EPSILON)
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
}

describe('the drift is fitted to the leash WITHOUT turning it (#1520)', () => {
  // Wide enough to cover a real regional cell. 0.24 is the synthetic fixture — included so the
  // blind spot is visible in the table rather than rediscovered.
  const aspects = [0.24, 0.5, 1, 1.5, 2, 3]

  it('the uniform fit never turns the displacement, at any aspect', () => {
    for (const a of aspects) {
      for (const phase of [0.5, 0.9, 1]) {
        // 0.001° — below anything a screen can show, and three orders under the 3.3° the
        // per-axis clamp produces at the mildest aspect that triggers it. Not tighter: `acos`
        // near zero carries its own rounding, and a bound inside that is measuring float noise.
        expect(misalignmentDeg(a, phase, fitUniform), `aspect ${a}, phase ${phase}`).toBeLessThan(
          1e-3,
        )
      }
    }
  })

  it('…and the per-axis clamp it replaced DOES, which is the reported bug', () => {
    // Fail-before, kept in the file: reinstating a per-axis clamp reintroduces exactly this.
    const worst = Math.max(...aspects.map((a) => misalignmentDeg(a, 0.9, fitPerAxis)))
    expect(worst, 'the per-axis clamp turns the drift on a wide cell').toBeGreaterThan(5)
  })

  it('the fixture CANNOT see it — which is why it took a live report to find', () => {
    // Recorded so nobody concludes "not reproducible" from the synthetic demo again.
    expect(misalignmentDeg(0.24, 1, fitPerAxis)).toBeLessThan(1e-3)
  })

  it('the VS scales by ONE factor — no per-component clamp on the displacement', () => {
    const w = emitArrowRetainedAdvectedWgsl()
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    // The displacement is divided by the leash and then scaled; a `clamp(…, -1.0, 1.0)` applied
    // to it is the broken form. The FS's coverage clamps are outside this slice.
    expect(body, 'the drift is not clamped per component').not.toMatch(/clamp\([^)]*-1\.0, 1\.0\)/)
  })
})

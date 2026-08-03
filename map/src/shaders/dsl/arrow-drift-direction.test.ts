// ═══ An arrow must MOVE in the direction it POINTS (#1520) ═══
//
// Reported from S-111 Live at `#11.30/38.74143/-74.93501` and `#12.80/38.76332/-74.97529`:
// "the direction the arrow travels and the direction it faces are different."
//
// THE ORIGINAL CAUSE, kept because the reasoning is what stops it coming back. The displacement
// had to stay inside the box two projected basis anchors spanned, or the VS extrapolated a
// linearization past its range. Clamping the two components INDEPENDENTLY keeps it inside — and
// TURNS it, because each component is cut by a different amount. It only fired when a component
// exceeded the leash, which needs `phase · uvAspect > 1`; the synthetic demo fixture has aspect
// 0.24 and can NEVER reach it, which is why three rounds of reproduction on that fixture found
// nothing while a real regional cell (usually wider than it is tall) showed it immediately.
//
// WHY THE CLASS IS NOW UNREACHABLE, not merely fixed. #1520 step 2 removed the leash box along
// with the per-cell generator that packed its anchors. A train is walked in SCREEN ARC LENGTH: at
// each step the sampled velocity is turned into a uv direction, that direction is mapped through
// the node's basis, and the step is that mapped vector scaled to the step length. There is no
// bound to fit into, so there is nothing that can cut one component more than the other — and the
// glyph's rotation is the SAME mapped vector. Travelling and pointing are not two computations
// that must agree; they are one.
//
// So this file pins the structure that makes them one, and keeps the arithmetic of the rejected
// fit as the fail-before: reinstating a per-axis clamp reintroduces exactly the reported angles.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl } from './arrow-advected'

/** The two candidate ways to keep a displacement inside a leash box — the rejected one and the
 *  one that replaced it, kept so the measured angles below stay in the record. */
const fitPerAxis = (kx: number, ky: number): [number, number] => [
  Math.max(-1, Math.min(1, kx)),
  Math.max(-1, Math.min(1, ky)),
]

/** Angle in degrees between the displacement and the glyph's own direction, both expressed in the
 *  uv terms the VS uses: the flow is `(vu, −vv·aspect)` and the glyph is rotated by the same, so
 *  any angle between them comes from the fit and nothing else. */
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

describe('the reported failure, as arithmetic — kept as the fail-before', () => {
  // Wide enough to cover a real regional cell. 0.24 is the synthetic fixture — included so the
  // blind spot stays visible in the table rather than being rediscovered.
  const aspects = [0.24, 0.5, 1, 1.5, 2, 3]

  it('a per-axis clamp turns the displacement on a wide cell', () => {
    const worst = Math.max(...aspects.map((a) => misalignmentDeg(a, 0.9, fitPerAxis)))
    expect(worst, 'the per-axis clamp turns the drift on a wide cell').toBeGreaterThan(5)
  })

  it('the fixture CANNOT see it — which is why it took a live report to find', () => {
    // Recorded so nobody concludes "not reproducible" from the synthetic demo again.
    expect(misalignmentDeg(0.24, 1, fitPerAxis)).toBeLessThan(1e-3)
  })
})

describe('…and the VS makes both directions ONE computation (#1520)', () => {
  const all = emitArrowRetainedAdvectedWgsl()
  const vs = all.slice(all.indexOf('fn vs_arrow_retained_advected'))
  const body = vs.slice(0, vs.indexOf('\n}'))
  const letOf = (name: string): string => {
    const m = new RegExp(`let ${name} = ([^;]+);`).exec(body)
    expect(m, `${name} must be bound in the emitted VS`).not.toBeNull()
    return m![1]!
  }

  it('the glyph is rotated by the SAME basis application the walk steps along', () => {
    // `cos_c`/`ss` are built from `arrow_uv_to_px(basis, (vu, −vv·aspect))`, which the emitter
    // inlines as the 2×2 product. The walk's own step is `arrow_uv_step(basis, (vu, −vv·aspect),
    // len)` mapped through that identical product. Severing the pairing — sampling the flow for
    // the rotation at a different position than the step uses, or applying a different basis —
    // is the class of bug that reads as "moves one way, points another".
    // The rotation: `(m.x·d.x + m.y·d.y, m.z·d.x + m.w·d.y)` for the basis `m` and the sampled
    // flow `d`. The VS applies the basis in more than one place now — the ground SNAP uses the
    // same 2x2 shape — so the candidates are enumerated and the one whose operand reaches a
    // velocity FETCH is the direction. Picking by position would be a test that breaks whenever a
    // line moves; picking by what it is made of is a test of the claim.
    const cands = [
      ...body.matchAll(/let \w+ = vec2<f32>\(\(\((\w+)\.x \* (\w+)\) \+ \(\1\.y \* (\w+)\)\)/g),
    ]
    expect(cands.length, 'the basis is applied at all').toBeGreaterThan(0)
    const fromFlow = cands.filter((m) => {
      const comp = letOf(m[2]!)
      const src = /vec2<f32>\((\w+),/.exec(comp)
      return src !== null && letOf(src[1]!).includes('textureLoad(flow_u_tex')
    })
    expect(fromFlow.length, 'exactly one basis application is built from the sampled flow').toBe(1)
    const basis = fromFlow[0]![1]!

    // … and it must be the SAME basis every walk step is mapped through. Two bases — one for
    // where the glyph goes and one for where it points — is precisely the reported failure, and
    // it is the only way this VS could still produce it.
    const steps = [...body.matchAll(/arrow_uv_step\((\w+),/g)].map((m) => m[1]!)
    expect(steps.length, 'the walk takes its steps through a basis').toBeGreaterThan(0)
    for (const st of steps) expect(st, 'one basis, both answers').toBe(basis)
  })

  it('nothing clamps a displacement COMPONENT — there is no box left to fit into', () => {
    // The leash box went with the per-cell generator. A `clamp(…, -1.0, 1.0)` reappearing in this
    // body is that box coming back, and with it the turn. The FS's coverage clamps are outside
    // this slice; `loadAtUv`'s texel clamp is a texture index, not a displacement, and clamps to
    // `(0, dim−1)`.
    expect(body, 'no displacement is clamped per component').not.toMatch(
      /clamp\([^)]*-1\.0, 1\.0\)/,
    )
  })

  it('the step direction is NORMALIZED before it is scaled — speed sets colour, not spacing', () => {
    // The train's spacing is a screen constant, so the walk advances by arc LENGTH and the
    // velocity contributes only a direction. A step proportional to the speed would space fast
    // water's glyphs further apart than slow water's, which on a chart reads as a second,
    // contradictory speed encoding beside the band colour the catalogue actually specifies.
    expect(all).toContain('fn arrow_uv_step(')
    const step = all.slice(all.indexOf('fn arrow_uv_step('))
    expect(step.slice(0, step.indexOf('\n}')), 'the direction is unit-scaled').toMatch(
      /max\(length\(dir_uv\)/,
    )
  })
})

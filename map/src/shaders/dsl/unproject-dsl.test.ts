// ═══ The backward map's SHAPE, pinned where a render cannot see it (#1520) ═══
//
// The screen→geographic step is where an f32 shader meets earth-radius magnitudes, and the two
// mistakes it invites are both invisible in a still frame: they show up as a lattice that SHAKES
// under camera motion, which `geo/src/globe.ts:358` already measured once at "~8 px at screen
// centre and tens of px under motion at z17+". A render gate catches that only if it moves the
// camera and looks hard; these assertions catch it in the emitted bytes.
//
// Each one names the specific arithmetic it forbids, so a failure says which half was severed.

import { describe, it, expect } from 'vitest'
import { module, emitModule, emitGlslModule, compileModuleJs } from '@xgis/shader-dsl'
import { getGpuProjectionFuncs, PROJECTION_CONSTS } from './projections'
import {
  UNPROJECT_FUNCS,
  UNPROJECT_NEWTON_STEPS,
  UNPROJECT_RESIDUAL_M,
  UNPROJECT_RESIDUAL_REL,
} from './unproject-dsl'

const wgsl = (): string =>
  emitModule(
    module({ consts: PROJECTION_CONSTS, funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS] }),
  )

/** The emitted body of one function, so an assertion cannot accidentally match a sibling's. */
const bodyOf = (src: string, name: string): string => {
  const at = src.indexOf(`fn ${name}(`)
  expect(at, `${name} is in the emit`).toBeGreaterThan(-1)
  const rest = src.slice(at)
  return rest.slice(0, rest.indexOf('\n}'))
}

describe('screen → geographic, on the GPU (#1520)', () => {
  it('emits on both backends', () => {
    const w = wgsl()
    expect(w).toContain('fn unproject_flat(')
    expect(w).toContain('fn ray_hit_sphere_enu(')
    const g = emitGlslModule(
      module({
        consts: PROJECTION_CONSTS,
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS],
      }),
      'vertex',
    )
    expect(typeof g).toBe('string')
  })

  it('INVERTS NO MATRIX — the ray is a blend of four corner directions', () => {
    // The trap `globe.ts` paid for: inverting an MVP whose eye sits 6.4e6 m out quantises the ray
    // hit by ~1 m in f32. There is nothing to invert if the ray arrives already unprojected, so
    // the check is that the blend is all this body does.
    const w = wgsl()
    const body = bodyOf(w, 'ray_from_corners')
    expect(body, 'the ray is blended, not solved').not.toMatch(/inverse|determinant|adjugate/i)
    expect(body, 'bilinear between the four corners').toMatch(/mix\(/)
    expect(bodyOf(w, 'ray_hit_plane')).not.toMatch(/inverse/i)
    expect(bodyOf(w, 'ray_hit_sphere_enu')).not.toMatch(/inverse\(/i)
  })

  it('the sphere quadratic never forms |C|² − R² — the term that loses every f32 figure', () => {
    // Solved in ENU, where the earth centre is (0, 0, −(R + h)) and the constant term falls out as
    // `h·(2R + h)` with no rearrangement. The ECEF form would need `|O|² − R²`, a difference of two
    // numbers near 4.1e13 that f32 reduces to noise — which reads as the z17+ shake, not as a
    // wrong picture, so no still frame catches it.
    const body = bodyOf(wgsl(), 'ray_hit_sphere_enu')
    expect(
      body,
      'the squared earth radius is never subtracted from a squared position',
    ).not.toMatch(/-\s*\(?\s*EARTH_R\s*\*\s*EARTH_R/)
    // The constant term is built from two PRODUCTS (`|eye|² + 2R(eye·up)`), so every operand is
    // altitude-scaled and nothing near 4.1e13 is ever formed. The tell is that the only thing
    // subtracted in this body is the discriminant's own `b² − 4ac`.
    expect(body, 'the constant term is a sum of products').toMatch(/dot\(/)
    const subs = body.match(/\s-\s/g) ?? []
    expect(subs.length, 'the only subtraction is the discriminant').toBeLessThanOrEqual(2)
  })

  it('the near root is taken in the form that does not cancel', () => {
    // `(−b − √disc)/2a` differences two nearly equal numbers whenever the camera is close to the
    // surface — every deep zoom, which is exactly where the shake was reported. The algebraically
    // identical `2c/(−b + √disc)` ADDS them. Severing this is invisible in a still frame and shows
    // only as motion jitter, so it is asserted on the emitted bytes.
    const body = bodyOf(wgsl(), 'ray_hit_sphere_enu')
    // The denominator ADDS the root to −b …
    const sq = body.match(/let (\w+) = sqrt\(max\(/)?.[1]
    expect(sq, 'the discriminant root is bound').toBeTruthy()
    expect(body, '−b + √disc, never −b − √disc').toMatch(new RegExp(`\\(-\\w+\\) \\+ ${sq}\\b`))
    expect(body, 'the cancelling root is not the one emitted').not.toMatch(
      new RegExp(`\\(-\\w+\\) - ${sq}\\b`),
    )
    // …and the numerator is twice the constant term, not −b at all.
    expect(body, 'the numerator is 2c').toMatch(/\(2\.0 \* \w+\) \/ select\(/)
  })

  it('the sphere hit is exact for a straight-down ray — the case arithmetic can be checked by hand', () => {
    const M = compileModuleJs(
      module({
        consts: PROJECTION_CONSTS,
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS],
      }),
    )
    const R = 6378137
    const UP = [0, 0, 1]
    for (const h of [100, 1e4, 1e6]) {
      // Eye at altitude h over the world origin, looking straight down: the surface is exactly h
      // below, and the hit is the origin itself.
      const hit = M.fns.ray_hit_sphere_enu([0, 0, h], [0, 0, -1], UP, R) as [
        number,
        number,
        number,
        number,
      ]
      expect(hit[3], `h=${h} hits`).toBe(1)
      expect(hit[2], `h=${h} lands on the surface`).toBeCloseTo(0, 3)
    }
    // A ray pointing UP never meets the earth — and must say so rather than returning a far-side
    // root, which would paint arrows on the sky.
    expect(
      (M.fns.ray_hit_sphere_enu([0, 0, 1e6], [0, 0, 1], UP, R) as number[])[3],
      'an upward ray misses',
    ).toBe(0)
  })

  it('the ray origin is the EYE, not the world origin — the pitch set-back is not dropped', () => {
    // `buildECEFFrameView` anchors the world at the camera's GROUND point and pulls the eye back
    // over it, so at pitch the eye has a nonzero xy. An implementation that assumed the eye at the
    // origin returns the same answer for both of these; one that reads it returns two answers a
    // whole set-back apart. Straight down from an eye offset 5 km north lands 5 km north.
    const M = compileModuleJs(
      module({
        consts: PROJECTION_CONSTS,
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS],
      }),
    )
    const R = 6378137
    const overOrigin = M.fns.ray_hit_sphere_enu([0, 0, 2e4], [0, 0, -1], [0, 0, 1], R) as number[]
    const setBack = M.fns.ray_hit_sphere_enu([0, 5e3, 2e4], [0, 0, -1], [0, 0, 1], R) as number[]
    expect(setBack[3], 'the set-back ray still hits').toBe(1)
    expect(setBack[1] - overOrigin[1], 'the hit moves with the eye').toBeCloseTo(5e3, 0)
    // …and the flat plane hit carries the same set-back.
    const planeOrigin = M.fns.ray_hit_plane([0, 0, 1e3], [0, 0, -1]) as number[]
    const planeSetBack = M.fns.ray_hit_plane([0, 700, 1e3], [0, 0, -1]) as number[]
    expect(planeSetBack[2], 'the set-back plane ray still hits').toBe(1)
    expect(planeSetBack[1] - planeOrigin[1], 'the plane hit moves with the eye').toBeCloseTo(700, 6)
  })

  it('the flat inverse is NUMERICAL — it calls the generated forward, it does not restate it', () => {
    // The whole argument for Newton over seven hand-written inverses: a projection added to
    // `PROJECTIONS` is invertible the day it lands. That property exists only while this body
    // CALLS `project` rather than carrying its own copy of any projection's math.
    const src = wgsl()
    const body = bodyOf(src, 'unproject_flat')
    // The value per Newton step, plus the centre for the initial guess and the residual check
    // that decides `ok`. The two Jacobian columns are one call to `flat_jacobian` per step —
    // ONE statement of that finite difference, shared with the screen-lattice basis.
    const own = body.match(/[^_]project\(/g) ?? []
    expect(own.length, 'forward evaluations in the flat inverse').toBe(UNPROJECT_NEWTON_STEPS + 2)
    const jac = body.match(/flat_jacobian\(/g) ?? []
    expect(jac.length, 'one Jacobian per Newton step').toBe(UNPROJECT_NEWTON_STEPS)
    // …and the Jacobian is itself two forward evaluations, so the total per step is still three.
    expect((bodyOf(src, 'flat_jacobian').match(/[^_]project\(/g) ?? []).length).toBe(2)
    expect(body, 'no projection math is restated here').not.toMatch(/0\.8707|1\.007226|log\(tan\(/)
  })

  it('the convergence threshold clears the f32 FLOOR of the coordinate it measures', () => {
    // PAID FOR ON A REAL GPU. A fixed 1 m threshold is not reachable in f32 at Web Mercator
    // magnitudes: x at the S-111 demo's longitude is −8 481 432 m, inside [2^23, 2^24) where the
    // f32 ULP is exactly 1.0 m. `|chk.x − target.x| + |chk.y − target.y|` is then a multiple of
    // 1.0 + 0.5, so `res < 1` admitted a node only when chk.x landed on the SAME f32 as target.x —
    // and because the rounding varies smoothly across the screen, the rejections came in BANDS.
    // The field rendered with ~40 % of its lattice missing.
    //
    // Nothing without a GPU could see it: the DSL's CPU lowering is f64, where the residual is
    // ~1e-9 and the round-trip identity passes at sub-pixel with the bug live (§5).
    //
    // So the claim is arithmetic, not a shader-text match: at every magnitude this runs at, the
    // threshold must exceed the ULP the residual is quantised to. Reinstating the fixed metre
    // fails the mercator rows below, which is the fail-before.
    const ulp = (v: number): number => 2 ** (Math.floor(Math.log2(Math.abs(v))) - 23)
    const tol = (x: number, y: number): number =>
      Math.max(UNPROJECT_RESIDUAL_M, (Math.abs(x) + Math.abs(y)) * UNPROJECT_RESIDUAL_REL)
    // |x|, |y| in the forward's own metres: the S-111 demo, the antimeridian, and a point near the
    // projection origin where the FLOOR is what carries the threshold.
    for (const [x, y, label] of [
      [-8_481_432, 4_593_562, 'the S-111 demo centre'],
      [20_037_508, 20_037_508, 'the antimeridian corner'],
      [1_000, 1_000, 'near the projection origin'],
    ] as const) {
      const quantum = ulp(x) + ulp(y)
      expect(
        tol(x, y),
        `${label}: the threshold must clear the residual's own quantum`,
      ).toBeGreaterThan(quantum)
    }
    // …and it stays FIVE ORDERS below a genuine non-convergence, so the gate still discriminates:
    // a node past a pole or off an oval edge sits at 1e5-1e6 m.
    expect(tol(20_037_508, 20_037_508)).toBeLessThan(1e4)
  })

  it('…and the emitted gate is that relative threshold, not a bare constant', () => {
    // Severing the mechanism specifically: a `res < 1.0` with no magnitude term is the exact
    // regression, and it is one character away from passing every other assertion in this file.
    const body = bodyOf(wgsl(), 'unproject_flat')
    expect(body, 'the threshold is built from the target magnitude').toMatch(
      /max\(1\.0, \(\(abs\(dest\.x\) \+ abs\(dest\.y\)\) \* /,
    )
    expect(body, 'the residual is compared against it, not against a literal').toMatch(
      /select\(0\.0, 1\.0, \(\w+ < \w+\)\)/,
    )
  })

  it('a non-invertible node is reported as a MISS, never clamped to a fabricated position', () => {
    // A clamped node stacks on the projection's edge and paints an arrow over water it was never
    // sampled from — a wrong chart, not a cosmetic one. The residual gate is what prevents it.
    const body = bodyOf(wgsl(), 'unproject_flat')
    expect(body, 'the residual decides the ok flag').toMatch(/select\(/)
  })
})

// ── The claim the shape assertions cannot make: that it actually INVERTS ──────────────────────
//
// Compiled through the DSL's own CPU lowering (`compileModuleJs`, the same path
// `cpu-projections.ts` uses), so this exercises the REAL op tree rather than a JS re-statement of
// it. What it tests is the ALGORITHM — that Newton contracts for every projection in the table,
// from the equirectangular initial guess, over the whole domain. The f32 conditioning is a
// separate question and is pinned by the emit assertions above plus the render gate.
describe('…and it actually inverts, for every projection in the table', () => {
  const M = compileModuleJs(
    module({ consts: PROJECTION_CONSTS, funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS] }),
  )
  // projType 7 (globe) has no 2D forward — it is the ray-ellipsoid path, not this one.
  const FLAT = [0, 1, 2, 3, 4, 5, 6]
  const CENTRE: [number, number] = [-76, 38]

  for (const t of FLAT) {
    it(`projType ${t}: forward → inverse recovers the point`, () => {
      const pp = [t, CENTRE[0], CENTRE[1], 0]
      let checked = 0
      for (let dlat = -20; dlat <= 20; dlat += 10) {
        for (let dlon = -20; dlon <= 20; dlon += 10) {
          const lon = CENTRE[0] + dlon
          const lat = CENTRE[1] + dlat
          const [x, y] = M.fns.project(lon, lat, pp) as [number, number]
          const [rlon, rlat, ok] = M.fns.unproject_flat([x, y], pp) as [number, number, number]
          // An azimuthal disc legitimately reports a miss for a point on its far side; what may
          // never happen is a point being ACCEPTED at the wrong place.
          if (ok < 0.5) continue
          expect(rlon, `projType ${t} lon at (${lon}, ${lat})`).toBeCloseTo(lon, 3)
          expect(rlat, `projType ${t} lat at (${lon}, ${lat})`).toBeCloseTo(lat, 3)
          checked++
        }
      }
      // Without this the loop above passes by reporting a miss everywhere — the exact vacuous
      // shape §12 warns about.
      expect(checked, `projType ${t} accepted some points`).toBeGreaterThan(15)
    })
  }

  it('a point outside the projection is REJECTED, not clamped to a fabricated one', () => {
    // Natural Earth's oval: a target far outside it has no preimage. The contract is ok = 0.
    const pp = [2, 0, 0, 0]
    const [, , ok] = M.fns.unproject_flat([9e7, 9e7], pp) as [number, number, number]
    expect(ok, 'a target with no preimage is a miss').toBe(0)
  })
})

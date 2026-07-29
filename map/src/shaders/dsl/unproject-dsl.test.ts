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
import { UNPROJECT_FUNCS, UNPROJECT_NEWTON_STEPS } from './unproject-dsl'

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
    expect(body, 'the altitude form is the one that is emitted').toMatch(/EARTH_R\s*\+/)
  })

  it('the sphere hit is exact for a straight-down ray — the case arithmetic can be checked by hand', () => {
    const M = compileModuleJs(
      module({
        consts: PROJECTION_CONSTS,
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS],
      }),
    )
    for (const h of [100, 1e4, 1e6]) {
      const hit = M.fns.ray_hit_sphere_enu([0, 0, -1], h) as [number, number, number, number]
      // Straight down from altitude h, the surface is exactly h below.
      expect(hit[3], `h=${h} hits`).toBe(1)
      expect(hit[2], `h=${h} depth`).toBeCloseTo(-h, 3)
    }
    // A ray pointing UP never meets the earth — and must say so rather than returning a far-side
    // root, which would paint arrows on the sky.
    expect((M.fns.ray_hit_sphere_enu([0, 0, 1], 1e6) as number[])[3], 'an upward ray misses').toBe(
      0,
    )
  })

  it('the flat inverse is NUMERICAL — it calls the generated forward, it does not restate it', () => {
    // The whole argument for Newton over seven hand-written inverses: a projection added to
    // `PROJECTIONS` is invertible the day it lands. That property exists only while this body
    // CALLS `project` rather than carrying its own copy of any projection's math.
    const body = bodyOf(wgsl(), 'unproject_flat')
    const calls = body.match(/project\(/g) ?? []
    // Three per Newton step (the value and the two Jacobian columns), plus the centre for the
    // initial guess and the residual check that decides `ok`.
    expect(calls.length, 'forward evaluations in the flat inverse').toBe(
      UNPROJECT_NEWTON_STEPS * 3 + 2,
    )
    expect(body, 'no projection math is restated here').not.toMatch(/0\.8707|1\.007226|log\(tan\(/)
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

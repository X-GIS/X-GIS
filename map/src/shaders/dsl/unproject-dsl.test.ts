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
    expect(w).toContain('fn ray_hit_ellipsoid(')
    const g = emitGlslModule(
      module({
        consts: PROJECTION_CONSTS,
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS],
      }),
      'vertex',
    )
    expect(typeof g).toBe('string')
  })

  it('INVERTS NO MATRIX — the ray is built from the camera basis', () => {
    // The trap `globe.ts` paid for: inverting an MVP whose eye sits 6.4e6 m out quantises the ray
    // hit by ~1 m in f32. There is nothing to invert if the ray comes from three unit vectors, so
    // the check is that no inverse ever appears.
    const w = wgsl()
    expect(
      bodyOf(w, 'camera_ray'),
      'camera_ray builds a direction, it does not solve one',
    ).not.toMatch(/inverse|determinant|adjugate/i)
    expect(bodyOf(w, 'ray_hit_plane')).not.toMatch(/inverse/i)
    expect(bodyOf(w, 'ray_hit_ellipsoid')).not.toMatch(/inverse\(/i)
  })

  it('the ellipsoid quadratic never forms |O|² − a² — the term that loses every f32 figure', () => {
    // `|O|² − a²` is a difference of two numbers near 4.1e13; f32 holds ~7 significant digits, so
    // the result is noise. Written `h·(2a + h) + Oz²·(k² − 1)` it is a sum of PRODUCTS and every
    // figure survives. A regression here reads as the z17+ shake, not as a wrong picture.
    const body = bodyOf(wgsl(), 'ray_hit_ellipsoid')
    expect(
      body,
      'the squared earth radius is never subtracted from a squared position',
    ).not.toMatch(/-\s*\(?\s*EARTH_R\s*\*\s*EARTH_R/)
    expect(body, 'the altitude form is the one that is emitted').toMatch(/EARTH_R\s*\+/)
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

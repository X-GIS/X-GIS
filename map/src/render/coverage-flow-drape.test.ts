import { describe, it, expect } from 'vitest'
import { emitCoverageWgsl, buildCoverageModule, coverageU } from '../shaders/dsl/coverage-ramp'
import { emitGlslModule, wgslLayout } from '@xgis/shader-dsl'
import { packCoverageUniforms, COVERAGE_UNIFORM_FLOATS } from './material/coverage-material'
import { FLOW_DRAPE_MIX } from './flow-stepper'

// The drape samples the advected field (#1333 (b)) — the increment that finally puts the
// motion on screen.
//
// THE LOAD-BEARING PROPERTY IS THE OFF STATE. This shader is ONE pipeline shared by every
// coverage, so an S-102 bathymetry fill and a currents fill run the same fragment code. The
// gate is therefore not "does the motion appear" (that needs a GPU this environment does not
// have) but "does mix = 0 leave the pre-existing fill EXACTLY as it was" — a property that is
// checkable here, by arithmetic, and that no render survey would notice breaking subtly.

const WGSL = emitCoverageWgsl()
const GLSL_FS = emitGlslModule(buildCoverageModule(), 'fragment')

/** The fragment ENTRY's body, helpers above it excluded — they tap the same samplers, so
 *  the slice is what makes the taps below unambiguous. WGSL keeps the authored entry name;
 *  GLSL ES has one entry per unit and it IS `main()` (since #1858 the emitter no longer
 *  wraps the body in an `fs_cov_impl` fn, which is what this used to anchor on). */
const entryBody = (src: string): string => {
  const at = src.indexOf('fn fs_cov')
  return at >= 0 ? src.slice(at) : src.slice(src.indexOf('void main()'))
}

/** The entry's EXIT expression. WGSL spells it `return CovFragOut(<expr>)`; GLSL ES
 *  `main()` has no value to return and since #1867 does not build the struct either — the
 *  constructor's argument is written straight to the draw buffer (`color = <expr>;`). Each
 *  arm is anchored on its own spelling so the lanes below are compared on the same
 *  expression on both backends. */
const exitExpr = (body: string): string =>
  body.includes('CovFragOut(')
    ? body.slice(body.lastIndexOf('CovFragOut('))
    : body.slice(body.lastIndexOf('color = '))

/** Resolve a CSE temporary by the shape of its right-hand side. */
function tempFor(body: string, re: RegExp, what: string): string {
  const m = re.exec(body)
  expect(m, `${what}: temporary not found — the emission changed, repoint this gate`).not.toBeNull()
  return m![1]!
}

/** The temporary holding the `cov_flow` tap (WGSL and GLSL differ only in the sampler arg). */
function flowTempOf(src: string, name: string): string {
  const body = entryBody(src)
  return tempFor(body, /(\w+) = tex\w*\(cov_flow,[^;]*;/, `${name}: flow tap`)
}

describe('coverage flow drape (#1333)', () => {
  it('THE OFF STATE IS EXACT: gain is 1 − k + k·flow, so k = 0 gives exactly 1.0', () => {
    // Not `mix(rgb, flowRgb, k)` and not a branch: this form is an identity at k = 0 for
    // every finite flow sample, because 1−0 = 1, 0·flow = 0, and 1+0 = 1 are all exact in
    // IEEE-754 — and rgb·1.0 is exact for every finite rgb. A "close enough" no-op would
    // shift the whole existing fill by an ulp and no pixel survey would ever flag it.
    const gain = (k: number, flow: number) => 1 - k + k * flow
    for (const flow of [0, 0.5, 1, 0.123456789, 65504]) {
      expect(gain(0, flow), `k=0 must be an exact 1.0 for flow=${flow}`).toBe(1)
    }
    // ...and a mid-range k really does modulate, so the identity is not vacuous.
    expect(gain(FLOW_DRAPE_MIX, 0)).toBeCloseTo(1 - FLOW_DRAPE_MIX, 12)
    expect(gain(FLOW_DRAPE_MIX, 1)).toBe(1)
    expect(gain(FLOW_DRAPE_MIX, 0.5)).toBeLessThan(1)

    // The flow-only FLAG must be exact in the OFF direction too, and `mix` has two legal
    // implementations that do NOT agree at t = 1:
    //     A: a*(1-t) + b*t        B: a + t*(b-a)     (fused, what many GPUs emit)
    // At t = 0 both give exactly `a` (A: a*1 + b*0 = a; B: a + 0*(b-a) = a), so the RAMPED
    // path — the one that must stay byte-identical for every existing coverage — is exact on
    // either. At t = 1, form B gives `a + (b-a)`, which is NOT exactly b in general. That is
    // why byte-identity is claimed ONLY for the off state; the flow-only white may land an
    // ulp under 1.0 on some hardware, which is irrelevant for a colour we chose ourselves.
    const mixA = (a: number, b: number, t: number) => a * (1 - t) + b * t
    const mixB = (a: number, b: number, t: number) => a + t * (b - a)
    for (const a of [0, 0.25, 0.5, 1, 0.123456789]) {
      expect(mixA(a, 1, 0), `mix form A must select exactly a at t=0 (a=${a})`).toBe(a)
      expect(mixB(a, 1, 0), `mix form B must select exactly a at t=0 (a=${a})`).toBe(a)
    }
  })

  it('the SHADER computes that same gain, on both backends', () => {
    // The arithmetic above only means something if the emitted code is the same expression.
    for (const [name, src] of [
      ['WGSL', WGSL],
      ['GLSL', GLSL_FS],
    ] as const) {
      expect(src, `${name}: samples the flow texture`).toContain('cov_flow')
      // The flow tap is CSE'd into a temporary, so resolve its name and assert the gain is
      // built from THAT — matching an inline `textureSample(cov_flow...)` would break the
      // moment the compiler decides to share the tap, which is exactly what it does.
      const flowTemp = flowTempOf(src, name)
      expect(src, `${name}: gain is (1 - k) + k*flow`).toContain(
        `((1.0 - u.ramp_params.w) + (u.ramp_params.w * ${flowTemp}))`,
      )
    }
  })

  it('the flow tap reuses the DATA uv — the pair lives in the coverage’s own raster', () => {
    // Not a screen-space uv. A fullscreen/screen-space flow layer would need a per-fragment
    // screen→geo inverse, which is exactly the Mercator-only bake this drape's tessellation
    // retired (coverage-ramp.ts header). Sampling at the same `uv` the value/valid taps use
    // is what keeps the motion projection-general and globe-capable for free.
    // The DSL's CSE makes this checkable exactly: the grid uv is computed ONCE into a
    // temporary and every tap references it, so identity is provable from the emitted text
    // rather than inferred from two similar-looking expressions.
    for (const [name, src] of [
      ['WGSL', WGSL],
      ['GLSL', GLSL_FS],
    ] as const) {
      const body = entryBody(src)
      // REPOINTED (#1366 INC-3): uv used to be a TEMPORARY the fragment rebuilt from the
      // `cov_geo` denominators — an inverse that only works if the footprint is a rectangle
      // in lon/lat, which a projected cell is not. It is now a VARYING carried from the
      // vertex stage, so the anchor is the uv the VALUE tap samples, whatever its emitted
      // name. The INVARIANT is unchanged and is still the point: all three taps must sample
      // the SAME uv, or the motion drifts off the data it is supposed to be moving.
      // WGSL takes a sampler argument, GLSL does not — so the uv is the LAST argument in
      // both, and the optional middle group is what absorbs the backend difference.
      const tap = (tex: string) => new RegExp(`tex\\w*\\(${tex},(?:\\s*\\w+,)?\\s*([\\w.]+)\\)`)
      const valueTap = tap('cov_value').exec(body)
      expect(
        valueTap,
        `${name}: could not find the cov_value tap — repoint this gate`,
      ).not.toBeNull()
      const uv = valueTap![1]!
      for (const tex of ['cov_valid', 'cov_flow']) {
        const other = tap(tex).exec(body)
        expect(other, `${name}: could not find the ${tex} tap`).not.toBeNull()
        expect(other![1], `${name}: ${tex} must sample the SAME uv as cov_value`).toBe(uv)
      }
    }
  })

  it('THE TWO MODES: ramped keeps its area alpha, flow-only makes the MOTION the alpha', () => {
    // Ramped — the motion rides on RGB only. Modulating alpha there would make the trails
    // punch holes in the coverage fill, which reads as flicker rather than flow.
    // Flow-only — there is no fill to punch through, so alpha becomes the motion itself and
    // the basemap shows through except where a streak is. A solid neutral area would grey
    // out the imagery the currents are meant to be read against.
    //
    // Asserted against the CSE TEMPORARIES by name, never against a source identifier: the
    // DSL folds everything into `_cseN`, so a regex looking for /gain/ matches nothing and
    // passes whether or not alpha is modulated. That is how the first draft of this gate was
    // vacuous, and the fail-before pass is what caught it.
    for (const [name, src] of [
      ['WGSL', WGSL],
      ['GLSL', GLSL_FS],
    ] as const) {
      const body = entryBody(src)
      const flow = flowTempOf(src, name)
      const gain = tempFor(body, /(\w+) = \(\(1\.0 - u\.ramp_params\.w\)/, `${name}: gain`)
      const baseA = tempFor(body, /(\w+) = \(\w+ \* u\.ramp_params\.z\)/, `${name}: base alpha`)
      const ret = exitExpr(body)

      // Three colour lanes, each: mix(lutLane, 1.0, only) * gain.
      for (const lane of ['x', 'y', 'z'] as const) {
        expect(
          ret,
          `${name}: colour lane ${lane} selects on the flag and carries the gain`,
        ).toMatch(new RegExp(`mix\\(\\w+\\.${lane}, 1\\.0, u\\.cam_center\\.z\\) \\* ${gain}`))
      }
      // Alpha: mix(baseA, baseA*flow*k, only) — the gain must NOT appear in it.
      expect(ret, `${name}: alpha selects between the area and the motion`).toContain(
        `mix(${baseA}, ((${baseA} * ${flow}) * u.ramp_params.w), u.cam_center.z)`,
      )
      const alpha = ret.slice(ret.lastIndexOf('mix('))
      expect(alpha, `${name}: the RGB gain must not reach alpha`).not.toContain(gain)
    }
  })

  it('flowMix rides ramp_params.w and DEFAULTS to 0, so an old caller is unchanged', () => {
    // Every pre-#1333 call site omits it. If the default were anything else, every existing
    // coverage would silently change colour.
    const base = {
      mvp: new Float32Array(16),
      projParams: [0, 0, 0, 1] as [number, number, number, number],
      camCenter: [0, 0] as [number, number],
      ramp: { a: 1, b: 0 },
      opacity: 1,
    }
    // REPOINTED (#1366 INC-3): `cov_edges` / `cov_geo` left the uniform block (8 floats),
    // sliding `ramp_params` from 32 down to 24 — so flowMix is .w at 27, not 35, and the
    // block is 28 floats, not 36. The claim being gated (the default is 0, it rides .w, and
    // it leaves opacity alone) is unchanged; only the offsets moved.
    expect(packCoverageUniforms(base)[27]).toBe(0)
    expect(packCoverageUniforms({ ...base, flowMix: FLOW_DRAPE_MIX })[27]).toBeCloseTo(
      FLOW_DRAPE_MIX,
      6,
    )
    // ...in the lane the shader actually reads, and without disturbing its neighbours.
    expect(WGSL).toContain('u.ramp_params.w')
    expect(packCoverageUniforms({ ...base, flowMix: 0.9 })[26]).toBe(1) // opacity, untouched
    // The pack's length is DERIVED from the shader struct, not pinned to a remembered number.
    // It was pinned to 28, and #1437's `cov_data` moved it to 32 — a literal here would have
    // to be re-remembered on every block change, which is the drift §12 keeps paying for.
    // std140 is the right layout to ask for: that is the qualifier the GLSL twin emits.
    expect(COVERAGE_UNIFORM_FLOATS * 4).toBe(wgslLayout(coverageU.struct, 'std140').size)
  })

  it('the binding is DECLARED in the shader and NAMED in the layout — WebGL2 binds by name', () => {
    expect(WGSL).toMatch(/@group\(0\)\s*@binding\(6\)\s*var\s+cov_flow\b/)
    expect(GLSL_FS).toContain('uniform sampler2D cov_flow')
  })

  it('FLOW_DRAPE_MIX is a single named authority, in (0,1)', () => {
    // 0 would disable the layer; ≥1 would drive the colour to black where the noise is 0.
    // Named in one place so the look can move without hunting a literal — and it is NOT
    // tuned, because tuning it is a judgement about an image and this environment has none.
    expect(FLOW_DRAPE_MIX).toBeGreaterThan(0)
    expect(FLOW_DRAPE_MIX).toBeLessThan(1)
  })
})

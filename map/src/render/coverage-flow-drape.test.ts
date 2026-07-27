import { describe, it, expect } from 'vitest'
import { emitCoverageWgsl, buildCoverageModule } from '../shaders/dsl/coverage-ramp'
import { emitGlslModule } from '@xgis/shader-dsl'
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
  })

  it('the SHADER computes that same gain, on both backends', () => {
    // The arithmetic above only means something if the emitted code is the same expression.
    for (const [name, src] of [
      ['WGSL', WGSL],
      ['GLSL', GLSL_FS],
    ] as const) {
      expect(src, `${name}: samples the flow texture`).toContain('cov_flow')
      // The literal emitted expression, both backends (WGSL `textureSample(t, s, uv)` vs
      // GLSL `texture(t, uv)` is the only difference). Asserting the SHAPE, not a temporary
      // name — the DSL common-subexpression-eliminates into `_cseN`.
      expect(src, `${name}: gain is (1 - k) + k*flow`).toMatch(
        /\(1\.0 - u\.ramp_params\.w\) \+ \(u\.ramp_params\.w \* tex\w*\(cov_flow/,
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
      const body = src.slice(src.indexOf('fs_cov'))
      // The uv temporary is the one built from the cov_geo denominators.
      const uvDecl = /(\w+) = vec2(?:<f32>)?\(\(\(\w+\.lon[\s\S]*?cov_geo\.w\)\);/.exec(body)
      expect(uvDecl, `${name}: could not find the uv temporary — repoint this gate`).not.toBeNull()
      const uv = uvDecl![1]!
      for (const tex of ['cov_value', 'cov_valid', 'cov_flow']) {
        expect(body, `${name}: ${tex} must sample the SAME uv temporary (${uv})`).toMatch(
          new RegExp(`tex\\w*\\(${tex},[^)]*\\b${uv}\\)`),
        )
      }
    }
  })

  it('the motion rides on RGB only — alpha is untouched', () => {
    // Modulating alpha would make the trails punch holes in the fill, which reads as flicker
    // rather than flow, and would also fight the ≤1-texel validity rim at hole boundaries.
    //
    // Asserted against the GAIN TEMPORARY BY NAME, not against the word "gain": the DSL
    // common-subexpression-eliminates it into `_cseN`, so no source identifier survives into
    // the emitted text. A regex looking for /gain/ matches nothing either way and passes
    // whether or not alpha is modulated — which is exactly how the first draft of this test
    // was vacuous, and the fail-before pass is what caught it.
    for (const [name, src] of [
      ['WGSL', WGSL],
      ['GLSL', GLSL_FS],
    ] as const) {
      const body = src.slice(src.indexOf('fs_cov'))
      const gainDecl = /(\w+) = \(\(1\.0 - u\.ramp_params\.w\)/.exec(body)
      expect(
        gainDecl,
        `${name}: could not find the gain temporary — repoint this gate`,
      ).not.toBeNull()
      const gain = gainDecl![1]!
      const ret = body.slice(body.lastIndexOf('return'))
      const args = ret.split(',')
      expect(args.length, `${name}: expected a 4-component return`).toBe(4)
      // The three colour lanes each carry it...
      const rgbLanes = args.slice(0, 3)
      for (const [i, lane] of rgbLanes.entries()) {
        expect(lane, `${name}: colour lane ${i} must carry the gain`).toContain(gain)
      }
      // ...and the alpha lane carries validity × layer opacity, and NOT the gain.
      const alpha = args[3]!
      expect(alpha, `${name}: alpha is validity × layer opacity`).toContain('u.ramp_params.z')
      expect(alpha, `${name}: the gain must NOT reach the alpha lane`).not.toContain(gain)
    }
  })

  it('flowMix rides ramp_params.w and DEFAULTS to 0, so an old caller is unchanged', () => {
    // Every pre-#1333 call site omits it. If the default were anything else, every existing
    // coverage would silently change colour.
    const base = {
      mvp: new Float32Array(16),
      projParams: [0, 0, 0, 1] as [number, number, number, number],
      camCenter: [0, 0] as [number, number],
      covEdges: [0, 0, 1, 1] as [number, number, number, number],
      covGeo: [0, 1, 1, 1] as [number, number, number, number],
      ramp: { a: 1, b: 0 },
      opacity: 1,
    }
    expect(packCoverageUniforms(base)[35]).toBe(0)
    expect(packCoverageUniforms({ ...base, flowMix: FLOW_DRAPE_MIX })[35]).toBeCloseTo(
      FLOW_DRAPE_MIX,
      6,
    )
    // ...in the lane the shader actually reads, and without disturbing its neighbours.
    expect(WGSL).toContain('u.ramp_params.w')
    expect(packCoverageUniforms({ ...base, flowMix: 0.9 })[34]).toBe(1) // opacity, untouched
    expect(COVERAGE_UNIFORM_FLOATS).toBe(36)
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

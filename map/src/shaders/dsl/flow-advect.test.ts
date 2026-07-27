import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitFlowAdvectWgsl, emitFlowAdvectGlsl, FLOW_NOISE_CELLS } from './flow-advect'

// IBFV advection step (#1333). This environment has no GPU, so — exactly as coverage-ramp.ts
// records for its own gate — the SHAPE is pinned now by emission assertions rather than left
// to a headed readback that cannot run here.
//
// The load-bearing gates are structural, not cosmetic. The technique was chosen because the
// blink is *unrepresentable*, and because the recursion carries no projection. Both of those
// are properties of what the shader does NOT contain, so that is what is asserted.

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'flow-advect.ts'), 'utf8')
/** Source with comments stripped — so a gate cannot be satisfied or broken by prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('flow-advect — IBFV step (#1333)', () => {
  it('emits on BOTH arms (#1046: dual-source DSL, never a backend fork)', () => {
    const wgsl = emitFlowAdvectWgsl()
    const glslV = emitFlowAdvectGlsl('vertex')
    const glslF = emitFlowAdvectGlsl('fragment')
    expect(wgsl).toContain('@fragment')
    expect(wgsl).toContain('fn fs_flow_advect')
    expect(glslV).toContain('#version 300 es')
    expect(glslF).toContain('#version 300 es')
    // Same entry-point name on both arms, so the Material's vsEntry is backend-identical.
    expect(wgsl).toContain('fn vs_flow_advect')
    expect(glslV).toContain('vs_flow_advect')
  })

  it('THE BLINK GATE: no lifetime, no fade, no respawn term exists at all', () => {
    // This is the whole reason IBFV replaced the arrow drift. The drift model forced
    // recycle → discontinuity → fade → blink; here there is nothing to recycle, so the blink
    // is not tuned away, it is unrepresentable. If any of these ever appear, the technique has
    // been reverted by accident and the blink is back.
    for (const banned of ['lifetime', 'phase_norm', 'fadeIn', 'fadeOut', 'smoothstep', 'respawn']) {
      expect(CODE, `advection must carry no "${banned}" term`).not.toContain(banned)
    }
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).not.toContain('lifetime')
    expect(wgsl).not.toContain('smoothstep')
    // The gate is not vacuous: the drift shader it replaced DOES contain these, so the
    // assertion distinguishes the two models rather than passing on any shader whatsoever.
    const drift = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'particle-retained.ts'),
      'utf8',
    )
    expect(drift).toContain('smoothstep')
    expect(drift).toContain('lifetime')
  })

  it('THE PROJECTION GATE: the recursive step imports no projection at all', () => {
    // Grid space, not screen space (design §3.2.1). A screen-space pass would need a
    // per-fragment screen→geo inverse — the Mercator-only bake that coverage-ramp.ts's
    // tessellation was introduced to retire. Importing ./projections here would mean that
    // bug has been reintroduced.
    expect(CODE).not.toContain('./projections')
    expect(CODE).not.toContain('pointU')
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).not.toContain('project')
    expect(wgsl).not.toContain('mvp')
    // ...and the shader really is self-contained about position: its only vertex output is a
    // fullscreen triangle, so there is no camera anywhere in the recursion.
    expect(wgsl).toContain('vec2<f32>(3.0, -1.0)')
  })

  it('steps BACKWARD along the field, and that fetch IS the local-current interpolation', () => {
    const wgsl = emitFlowAdvectWgsl()
    // uv.x MINUS the east component: semi-Lagrangian, "where did this come from".
    expect(wgsl).toMatch(/in\.uv\.x - \(_v\d+ \* u\.step\.x\)/)
    // Grid v runs north-down while the north component runs up, so y ADDS.
    expect(wgsl).toMatch(/in\.uv\.y \+ \(_v\d+ \* u\.step\.y\)/)
    // Both velocity components are sampled from the field, not carried per-instance.
    expect(wgsl).toContain('textureSample(u_tex, samp, in.uv)')
    expect(wgsl).toContain('textureSample(v_tex, samp, in.uv)')
  })

  it('CLAMPS the back-step rather than wrapping (a cell is bounded, not a torus)', () => {
    // Wrapping would advect one edge of a regional cell into the opposite edge — the Atlantic
    // into the Pacific across the seam.
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).toContain('clamp(')
    expect(wgsl).not.toContain('fract((in.uv')
    expect(CODE).not.toMatch(/wrap|repeat/i)
  })

  it('blends history and noise with a CONSTANT weight — every texel treated identically', () => {
    // A per-texel or per-time weight would be a lifetime in disguise.
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).toMatch(/u\.step\.z/) // decay on the history
    expect(wgsl).toMatch(/u\.step\.w/) // injection weight
    expect(wgsl).toMatch(/1\.0 - u\.step\.w/)
  })

  it('hashes without `sin`, whose quality diverges between the WGSL and GLSL arms', () => {
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).toContain('fn flow_hash')
    expect(wgsl).not.toContain('sin(')
    expect(wgsl).toContain('fract(')
    expect(FLOW_NOISE_CELLS).toBeGreaterThan(0)
  })

  it('samples the velocity field, never a per-instance buffer (N-independent by construction)', () => {
    const wgsl = emitFlowAdvectWgsl()
    expect(wgsl).not.toContain('instance_index')
    expect(wgsl).not.toContain('feat_data')
    expect(wgsl).not.toContain('storage')
  })
})

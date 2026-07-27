import { describe, it, expect } from 'vitest'
import {
  FLOW_ADVECT_BINDINGS,
  FLOW_ADVECT_UNIFORM_FLOATS,
  packFlowAdvectUniform,
} from './flow-advect-material'
import { emitFlowAdvectWgsl, emitFlowAdvectGlsl } from '../../shaders/dsl/flow-advect'

// The advection material's binding contract (#1333).
//
// THE NAMES ARE THE POINT. WebGL2 binds by NAME, not by slot (rhi.ts #783), so an entry whose
// `name` does not match the shader's resource identifier binds nothing there — and it fails on
// WebGL2 ONLY, the backend this environment cannot run. So every name is checked against the
// EMITTED shader rather than against a second hand-written copy of the same list, which would
// only prove the two lists agree with each other.

const WGSL = emitFlowAdvectWgsl()
const GLSL_FS = emitFlowAdvectGlsl('fragment')

describe('FlowAdvectDraper bindings (#1333)', () => {
  it('TEXTURE entries carry the shader VARIABLE name — what WebGL2 samples by', () => {
    // In GLSL ES a texture is a `uniform sampler2D <name>`; the name is the handle.
    for (const b of FLOW_ADVECT_BINDINGS.filter((x) => x.kind === 'texture')) {
      expect(WGSL, `binding ${b.binding} declared`).toMatch(
        new RegExp(`@binding\\(${b.binding}\\)\\s*var\\s+${b.name}\\b`),
      )
      expect(GLSL_FS, `${b.name} must exist in the GLSL twin too`).toContain(
        `uniform sampler2D ${b.name}`,
      )
    }
  })

  it('the UNIFORM entry carries the STRUCT name — the GLSL block WebGL2 binds by', () => {
    // Not the WGSL variable name (`u`): GLSL names the BLOCK, and that is the binding key.
    // Same shape as the coverage precedent (uniformStruct('CoverageUniforms') <-> name:
    // 'CoverageUniforms'). Asserting the variable name here would have been wrong AND would
    // have looked right — the emitted WGSL does contain a `u`.
    const uni = FLOW_ADVECT_BINDINGS.find((b) => b.kind === 'uniform')!
    expect(WGSL).toMatch(
      new RegExp(`@binding\\(${uni.binding}\\)\\s*var<uniform>\\s+\\w+:\\s*${uni.name}\\b`),
    )
    expect(GLSL_FS, 'the GLSL block name is the WebGL2 binding key').toContain(
      `uniform ${uni.name} {`,
    )
  })

  it('the SAMPLER entry has no GLSL counterpart, and that is expected', () => {
    // GLSL ES 3.00 has no separate sampler objects — the emitter folds them into sampler2D.
    // Recorded so a future reader does not "fix" a missing declaration that should be missing.
    const samp = FLOW_ADVECT_BINDINGS.find((b) => b.kind === 'sampler')!
    expect(WGSL).toMatch(
      new RegExp(`@binding\\(${samp.binding}\\)\\s*var\\s+${samp.name}: sampler`),
    )
    expect(GLSL_FS).not.toContain(`uniform sampler ${samp.name}`)
  })

  it('declares EVERY binding the shader has — no resource left unbound', () => {
    // The other direction: a shader resource with no entry binds nothing, which is the same
    // silent WebGL2 failure seen from the opposite side.
    const inShader = [...WGSL.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((m) => Number(m[1]))
    const declared = FLOW_ADVECT_BINDINGS.map((b) => b.binding)
    expect([...new Set(inShader)].sort()).toEqual([...declared].sort())
  })

  it('the uniform struct is exactly the size the material reserves', () => {
    // AdvectParams is step: vec4f + phase: vec4f. A short reserve would write past the buffer;
    // a long one silently wastes and hides a layout drift.
    expect(FLOW_ADVECT_UNIFORM_FLOATS).toBe(8)
    expect(WGSL).toContain('struct AdvectParams')
    expect(WGSL).toContain('step: vec4<f32>')
    expect(WGSL).toContain('phase: vec4<f32>')
  })

  it('packs the uniform in the SHADER’s field order, not a plausible one', () => {
    // The shader reads step.x/.y as the displacement, .z as decay, .w as inject, and phase.x as
    // the noise phase. Any other order still runs and animates — wrongly.
    // toBeCloseTo per lane, not toEqual: the pack is a Float32Array, so 0.1 comes back as the
    // nearest f32 — an exact compare would fail on the storage, not on the field order.
    const u = packFlowAdvectUniform(0.1, 0.2, 0.9, 0.05, 7)
    const want = [0.1, 0.2, 0.9, 0.05, 7, 0, 0, 0]
    expect(u.length).toBe(want.length)
    want.forEach((w, i) => expect(u[i]!).toBeCloseTo(w, 6))
    // ...and the shader really does read those lanes for those roles.
    expect(WGSL).toMatch(/u\.step\.x/)
    expect(WGSL).toMatch(/u\.step\.y/)
    expect(WGSL).toMatch(/u\.step\.z/)
    expect(WGSL).toMatch(/u\.step\.w/)
    expect(WGSL).toMatch(/u\.phase\.x/)
  })

  it('the pack is float32 and zero-fills the pad, so no stale bytes reach the GPU', () => {
    const u = packFlowAdvectUniform(1, 1, 1, 1, 1)
    expect(u).toBeInstanceOf(Float32Array)
    expect(u.length).toBe(FLOW_ADVECT_UNIFORM_FLOATS)
    expect([...u].slice(5)).toEqual([0, 0, 0])
  })
})

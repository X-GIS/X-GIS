// Emit gates for the background-pattern shader module (#777 I-E).
//
// The cross-program constraint (#1046 twin-frame elimination §4) is that any
// NEW background/icon shader must come from shader-dsl emit so BOTH backends get
// twins by construction — otherwise the cluster recreates the RHI_TWIN_MISSING
// class the twin-kill is deleting. These gates prove ONE authored graph emits
// valid WGSL (WebGPU, today) AND valid GLSL ES 3.00 vertex + fragment (WebGL2,
// once F3/F4 flip the background pass). The writer owns every lexeme; the IR
// owns none — a WGSL lexeme must never leak into the GLSL and vice versa.

import { describe, it, expect } from 'vitest'
import { emitGlslModule } from '@xgis/shader-dsl'
import { buildBackgroundPatternModule, emitBackgroundPatternWgsl } from './background-pattern'

describe('background-pattern DSL — dual-source emit gate', () => {
  it('emits the WGSL twin: vs_full + fs_pattern, wrapped-UV atlas sample', () => {
    const wgsl = emitBackgroundPatternWgsl()
    // Both entry points present.
    expect(wgsl).toContain('fn vs_full(')
    expect(wgsl).toContain('fn fs_pattern(')
    // The wrapped-UV pattern tiling (fract) + the atlas sample.
    expect(wgsl).toContain('fract(')
    expect(wgsl).toContain('textureSample(')
    // WGSL spelling markers present.
    expect(wgsl).toContain('vec4<f32>')
    expect(wgsl).toContain('@location(0)')
    // The group-0 uniform + texture + sampler bindings.
    expect(wgsl).toContain('@group(0) @binding(0)')
    expect(wgsl).toContain('@group(0) @binding(1)')
    expect(wgsl).toContain('@group(0) @binding(2)')
  })

  it('emits the GLSL ES 3.00 vertex twin from the SAME IR', () => {
    const glsl = emitGlslModule(buildBackgroundPatternModule(), 'vertex')
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    // GLSL spelling, no WGSL lexemes leaked.
    expect(glsl).not.toContain('vec4<f32>')
    expect(glsl).not.toContain('@')
    expect(glsl).not.toMatch(/\bfn\b/)
    expect(glsl).not.toContain('let ')
  })

  it('emits the GLSL ES 3.00 fragment twin — fract tiling + combined sampler2D sample', () => {
    const glsl = emitGlslModule(buildBackgroundPatternModule(), 'fragment')
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    // The pattern tiling survives lowering.
    expect(glsl).toContain('fract(')
    // WGSL split texture+sampler lowers to a GLSL combined-sampler `texture(...)`.
    expect(glsl).toContain('texture(')
    expect(glsl).not.toContain('textureSample(')
    // No WGSL type/attr spelling anywhere.
    expect(glsl).not.toContain('<f32>')
    expect(glsl).not.toContain('@')
  })
})

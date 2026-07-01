import { describe, it, expect } from 'vitest'
import { emitIconWgsl, ICON_MODULE } from './icon'
import { compileModule } from '@xgis/shader-dsl'

// Phase-2 icon shader — first TEXTURED render shader. The fragment stage uses
// fwidth (screen-space, GPU-only) + textureSample, so it is not cpu-evaluated;
// the gate is the WGSL emission shape (texture-IR surface) + the GPU pixel
// survey. The vertex stage (px → NDC) IS cpu-evaluated.
describe('Phase-2 icon shader — DSL emission (texture IR surface)', () => {
  const w = emitIconWgsl()
  it('texture + sampler bindings emit with NO address space', () => {
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(w).toContain('@group(0) @binding(1) var atlas_tex: texture_2d<f32>;')
    expect(w).toContain('@group(0) @binding(2) var atlas_smp: sampler;')
  })
  it('vertex @location inputs + flat varying', () => {
    expect(w).toContain('@vertex\nfn vs(@location(0) pos_px: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) opacity: f32, @location(3) tint: vec3<f32>, @location(4) sdf: f32) -> VsOut')
    expect(w).toContain('@location(3) @interpolate(flat) sdf: f32,')
  })
  it('textured fragment: bare @location(0) return + textureSample + fwidth + swizzle', () => {
    expect(w).toContain('@fragment\nfn fs(in: VsOut) -> @location(0) vec4<f32>')
    expect(w).toContain('textureSample(atlas_tex, atlas_smp, in.uv)')
    expect(w).toContain('fwidth(')
    // raster path reads the .rgb swizzle off the sampled texel — robust to the
    // texel being inlined (`textureSample(...).rgb`) or bound to a cse temp
    // (`_cseN.rgb`) now the hand `let c` is dropped.
    expect(w).toMatch(/(?:textureSample\(atlas_tex, atlas_smp, in\.uv\)|\w+)\.rgb\b/)
    expect(w).toContain('smoothstep(')
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})

describe('Phase-2 icon shader — cpu vertex stage (px → NDC)', () => {
  it('vs maps pixel coords to NDC via the viewport uniform', () => {
    const M = compileModule(ICON_MODULE)
    M.setBinding('u', { viewport: [800, 600], _pad0: 0, _pad1: 0 } as unknown as never)
    const cases: Array<[[number, number], [number, number]]> = [
      [[400, 300], [0, 0]], [[0, 0], [-1, 1]], [[800, 600], [1, -1]],
    ]
    for (const [[px, py], [nx, ny]] of cases) {
      const out = M.fns.vs([px, py], [0.5, 0.5], 1, [1, 1, 1], 0) as { clip_pos: number[] }
      expect(out.clip_pos[0]).toBeCloseTo(nx, 6)
      expect(out.clip_pos[1]).toBeCloseTo(ny, 6)
      expect(out.clip_pos[3]).toBeCloseTo(1, 6)
    }
  })
})

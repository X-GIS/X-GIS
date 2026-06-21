import { describe, it, expect } from 'vitest'
import { emitTextWgsl, TEXT_MODULE } from './text'
import { compileModule } from '../core/backends/cpu'

// Phase-2 text shader (SDF glyph + halo) — second texture-IR shader after icon.
// The fragment samples a single-channel SDF atlas and antialiases with an
// analytic per-glyph-size half-width (soft = 2.52 / font_size_px) — NOT fwidth.
// It is not cpu-evaluated (texture sample); the gate is the WGSL emission shape
// + the GPU pixel survey. The vertex stage (px → NDC) IS cpu-evaluated.
describe('Phase-2 text shader — DSL emission (SDF glyph + halo)', () => {
  const w = emitTextWgsl()
  it('texture + sampler bindings emit with NO address space', () => {
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(w).toContain('@group(0) @binding(1) var atlas_tex: texture_2d<f32>;')
    expect(w).toContain('@group(0) @binding(2) var atlas_smp: sampler;')
  })
  it('vertex: two @location inputs → VsOut', () => {
    expect(w).toContain('@vertex\nfn vs(@location(0) pos_px: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut')
  })
  it('fragment: SDF sample + analytic AA (no fwidth) + halo early-out', () => {
    expect(w).toContain('@fragment\nfn fs(in: VsOut) -> @location(0) vec4<f32>')
    expect(w).toContain('textureSample(atlas_tex, atlas_smp, in.uv).x')
    expect(w).toContain('smoothstep(')
    expect(w).toContain('(u.halo_width <= 0.0)')   // no-halo early return
    expect(w).not.toContain('fwidth(')             // text AA is analytic, not a screen derivative
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})

describe('Phase-2 text shader — cpu vertex stage (px → NDC)', () => {
  it('vs maps pixel coords to NDC via the viewport uniform', () => {
    const M = compileModule(TEXT_MODULE)
    M.setBinding('u', {
      viewport: [800, 600], fill_color: [0, 0, 0, 1], halo_color: [0, 0, 0, 0],
      halo_width: 0, halo_blur: 0, font_size_px: 16, _pad1: 0,
    } as unknown as never)
    const cases: Array<[[number, number], [number, number]]> = [
      [[400, 300], [0, 0]], [[0, 0], [-1, 1]], [[800, 600], [1, -1]],
    ]
    for (const [[px, py], [nx, ny]] of cases) {
      const out = M.fns.vs([px, py], [0.5, 0.5]) as { clip_pos: number[] }
      expect(out.clip_pos[0]).toBeCloseTo(nx, 6)
      expect(out.clip_pos[1]).toBeCloseTo(ny, 6)
      expect(out.clip_pos[3]).toBeCloseTo(1, 6)
    }
  })
})

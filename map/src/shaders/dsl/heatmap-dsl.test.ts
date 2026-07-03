import { describe, it, expect } from 'vitest'
import { emitHeatmapAccumWgsl } from './heatmap-accum'
import { emitHeatmapBlurWgsl } from './heatmap-blur'
import { emitHeatmapComposeWgsl } from './heatmap-compose'

// Phase R heatmap shaders — the 3-pass pipeline (accum → blur → compose).
// CI compile-coverage is the WGSL-compile-gate e2e (SwiftShader); this vitest
// only asserts the emission SHAPE (structural well-formedness + the key
// bindings / entry points) so a structural regression fails fast on Windows.

describe('heatmap accum shader — DSL emission', () => {
  const w = emitHeatmapAccumWgsl()
  it('prepends the shared projection WGSL the VS calls', () => {
    expect(w).toContain('fn project')
    expect(w).toContain('fn flat_rel')
  })
  // ── #595: back-hemisphere heatmap cull ──
  it('vs_heatmap calls needs_backface_cull + select to discard back-facing splats (#595)', () => {
    // needs_backface_cull must be DEFINED and CALLED in the VS so back-facing
    // splat quads are collapsed to the degenerate position (w=0, discarded).
    expect(w).toContain('fn needs_backface_cull(')
    const vsBody = w.slice(w.indexOf('@vertex\nfn vs_heatmap'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).toContain('needs_backface_cull(')
    // select(cond, ifTrue, ifFalse) collapses back-facing quad to vec4(0,0,0,0)
    expect(vsOnly).toContain('select(')
  })
  it('uniform + feat_data storage binding', () => {
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(w).toContain('@group(0) @binding(1) var<storage, read> feat_data: array<f32>;')
  })
  it('vertex inputs: center / quad_id / feat_id', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain(
      'fn vs_heatmap(@location(0) center: vec2<f32>, @location(1) quad_id: u32, @location(2) feat_id: f32)',
    )
  })
  it('fragment emits a radial Gaussian density to the red channel', () => {
    expect(w).toContain('@fragment')
    expect(w).toContain('fn fs_heatmap')
    expect(w).toContain('exp(')
  })
  it('three-way projType branch (flat-Merc < 0.5 / flat-other < 6.5 / ECEF)', () => {
    expect(w).toContain('u.proj_params.x')
    expect(w).toContain('0.5')
    expect(w).toContain('6.5')
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})

describe('heatmap blur shader — DSL emission', () => {
  const w = emitHeatmapBlurWgsl()
  it('fullscreen-triangle VS + separable-Gaussian FS', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('fn vs_full')
    expect(w).toContain('@fragment')
    expect(w).toContain('fn fs_blur')
  })
  it('density texture + direction uniform bindings', () => {
    expect(w).toContain('var src_tex: texture_2d<f32>;')
    expect(w).toContain('var<uniform> p: BlurParams;')
  })
  it('samples via textureLoad (unfilterable density target)', () => {
    expect(w).toContain('textureLoad(src_tex')
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})

describe('heatmap compose shader — DSL emission', () => {
  const w = emitHeatmapComposeWgsl()
  it('density + ramp LUT + sampler + params bindings', () => {
    expect(w).toContain('var density_tex: texture_2d<f32>;')
    expect(w).toContain('var ramp_tex: texture_2d<f32>;')
    expect(w).toContain('var ramp_sampler: sampler;')
    expect(w).toContain('var<uniform> u: ComposeParams;')
  })
  it('fullscreen-triangle VS + ramp-mapped FS', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('fn vs_full')
    expect(w).toContain('@fragment')
    expect(w).toContain('fn fs_compose')
  })
  it('density → ramp coordinate via intensity, sampled from the LUT', () => {
    expect(w).toContain('textureLoad(density_tex')
    expect(w).toContain('textureSample(ramp_tex, ramp_sampler')
    expect(w).toContain('u.params.x') // intensity
    expect(w).toContain('u.params.y') // opacity
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})

import { describe, it, expect } from 'vitest'
import { emitHillshadeWgsl } from './hillshade'
import { emitRasterWgsl } from './raster'
import { hillshadeUniformSlots, hillshadeUniformBytes } from '../../render/hillshade-uniform-slots'

// #777 Phase II — hillshade shader. A hillshade tile is structurally a raster
// tile with a DEM-decode → Sobel → shade fragment; the vertex stage, procedural
// grid, projection dispatch, pole caps and VsOut varyings are SHARED VERBATIM
// with raster.ts. These assertions pin the shared-vertex reuse + the new
// fragment/uniform surface (GPU-free; the render A/B is INC-6, local/pre-push).
describe('Phase-II hillshade shader — DSL emission', () => {
  const noPick = emitHillshadeWgsl(false)
  const pick = emitHillshadeWgsl(true)

  it('emits vs_tile + fs_hillshade entry points', () => {
    expect(noPick).toContain('@vertex\nfn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut')
    expect(noPick).toContain('@fragment\nfn fs_hillshade(input: VsOut) -> HillshadeFragmentOutput')
  })

  it('fragment applies the LAYER opacity (raster_params.x) to the premultiplied output', () => {
    // #777 gap — the relief now honours the layer's `opacity` paint (was hardcoded 1); the
    // fragment scales the whole premultiplied RGBA by the shared raster-frame opacity uniform.
    const fs = noPick.match(/fn fs_hillshade[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fs).not.toBe('')
    expect(fs).toMatch(/raster_params\.x/)
  })

  it('shares the raster vertex authority byte-for-byte (single vs_tile source)', () => {
    // The vertex FUNCTION emitted by the hillshade module must be textually
    // identical to raster's — proof that vs_tile is ONE authority, not a fork.
    // Slice from the @vertex signature to vs_tile's own closing brace (the first
    // top-level `\n}\n`); what follows differs by module (raster → @fragment,
    // hillshade → the hs_elevation helper) and is not part of the vertex.
    const vsOf = (w: string) => {
      const s = w.indexOf('@vertex\nfn vs_tile')
      const body = w.slice(s)
      const end = body.indexOf('\n}\n')
      return end > 0 ? body.slice(0, end + 3) : body
    }
    expect(vsOf(noPick)).toBe(vsOf(emitRasterWgsl(false)))
  })

  it('binds shared vertex uniforms (g0b0 Uniforms, g1b0 TileUniforms) + DEM tex/sampler', () => {
    expect(noPick).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(noPick).toContain('@group(0) @binding(1) var tex: texture_2d<f32>;')
    expect(noPick).toContain('@group(0) @binding(2) var tex_sampler: sampler;')
    expect(noPick).toContain('@group(1) @binding(0) var<uniform> tile: TileUniforms;')
  })

  it('binds hillshade lighting (g0b3); reuses raster TileUniforms pool (no hillshade per-tile)', () => {
    expect(noPick).toContain('@group(0) @binding(3) var<uniform> hs: HillshadeUniforms;')
    expect(noPick).toContain('struct HillshadeUniforms')
    // The per-tile pool is the SHARED raster TileUniforms — no hillshade per-tile struct.
    expect(noPick).not.toContain('HillshadeTileUniforms')
    // The lighting struct carries the six vec4 lanes the renderer packs.
    for (const f of [
      'hs_unpack',
      'hs_light',
      'hs_shadow',
      'hs_highlight',
      'hs_accent',
      'hs_texel',
    ]) {
      expect(noPick).toContain(f)
    }
  })

  it('fragment DEM-decodes via the hs_elevation helper (unpack dot, ×255)', () => {
    expect(noPick).toContain('fn hs_elevation(uv: vec2<f32>) -> f32')
    const fs = noPick.slice(noPick.indexOf('fn hs_elevation'))
    // decode = dot(texel.rgb * 255, unpack.rgb) - unpack.w
    expect(fs).toContain('textureSample(tex, tex_sampler')
    expect(fs).toContain('255')
    expect(fs).toContain('hs.hs_unpack')
  })

  it('fragment reuses the raster per-fragment hemisphere cull (#595)', () => {
    expect(noPick).toContain('fn needs_backface_cull(')
    const fs = noPick.slice(noPick.indexOf('fn fs_hillshade'))
    expect(fs).toContain('needs_backface_cull(')
    expect(fs).toContain('discard')
    expect(fs).toContain('input.abs_merc_y')
    expect(fs).toContain('input.abs_lon')
  })

  it('fragment takes a 3×3 Sobel derivative scaled by the per-frame deriv + lat correction', () => {
    const fs = noPick.slice(noPick.indexOf('fn fs_hillshade'))
    // 8 neighbour taps of hs_elevation (3×3 minus centre).
    expect((fs.match(/hs_elevation\(/g) ?? []).length).toBe(8)
    // deriv scale (hs_texel.y) + Mercator cos(lat) correction.
    expect(fs).toContain('hs.hs_texel')
    expect(fs).toContain('cos(')
  })

  it('fragment shades via standard (accent) + basic (altitude) methods', () => {
    const fs = noPick.slice(noPick.indexOf('fn fs_hillshade'))
    expect(fs).toContain('hs.hs_accent') // standard uses accent
    expect(fs).toContain('hs.hs_shadow')
    expect(fs).toContain('hs.hs_highlight')
    expect(fs).toContain('atan2(') // standard aspect
    expect(fs).toContain('sqrt(') // basic Lambert denominator
    expect(fs).toContain('hs.hs_light') // azimuth / altitude / exaggeration / method
  })

  it('writes log frag_depth (draped over the same depth field as raster)', () => {
    expect(noPick).toContain('fn compute_log_frag_depth(')
    expect(noPick.slice(noPick.indexOf('fn fs_hillshade'))).toContain('compute_log_frag_depth(')
  })

  it('pick variant toggles the pick attachment field + write', () => {
    expect(noPick).not.toContain('pick: vec2<u32>')
    expect(pick).toContain('@location(1) @interpolate(flat) pick: vec2<u32>,')
    expect(pick).toContain('vec2<u32>(0u, 0u)')
  })

  it('both variants are structurally balanced', () => {
    for (const w of [noPick, pick]) {
      expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
      expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
    }
  })

  // Uniform slots (reflect-derived) — locks the byte layout the INC-3 CPU packer
  // writes into. HillshadeUniforms = 15 vec4 (240 B): the 6 single-source lanes
  // + the multidirectional sources 2..4 (per-source light + shadow + highlight).
  // The per-tile pool is the shared raster TileUniforms (rasterTileSlots), not a
  // hillshade struct.
  it('reflect-derives the hillshade uniform slot layout', () => {
    const hs = hillshadeUniformSlots()
    expect(hs.slots).toBe(60) // 15 vec4 × 4 f32
    expect(hillshadeUniformBytes()).toBe(240)
    for (const f of [
      'hs_unpack',
      'hs_light',
      'hs_shadow',
      'hs_highlight',
      'hs_accent',
      'hs_texel',
      'hs_light2',
      'hs_light3',
      'hs_light4',
      'hs_shadow2',
      'hs_highlight2',
      'hs_shadow3',
      'hs_highlight3',
      'hs_shadow4',
      'hs_highlight4',
    ]) {
      expect(hs.slot).toHaveProperty(f)
    }
  })
})

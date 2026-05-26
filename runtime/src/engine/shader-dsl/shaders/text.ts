// ═══ Shader DSL — text (SDF glyph + halo) shader (Phase 2) ═══
//
// Re-authors text/text-renderer.ts TEXT_SHADER_WGSL. Same texture-IR surface as
// icon.ts (texture_2d<f32> + sampler, textureSample, .r/.rgb/.a swizzles, a bare
// @location(0) fragment return) — but no fwidth: text uses a per-glyph-size
// analytic AA half-width, not a screen-space derivative.
//
// Load-bearing constants (full iter history in text-renderer.ts):
// - edge = 0.75 (= 192/256, MapLibre symbol_sdf buffer default).
// - soft = 2.52 / font_size_px — MapLibre's per-glyph-size AA half-width
//   (EDGE_GAMMA 0.105 × ONE_EM 24, DPR-cancelled), floored at 1/255.
// - aa_halo = halo_blur + soft (SUM, not MAX) — MapLibre gamma_halo after the
//   per-DPR/per-fontScale algebra; halo_blur arrives pre-packed in SDF-byte space.
// - Premultiplied output (rgb*a, a); halo composites behind the fill via the
//   (1 - fill_w) factor (one-pass equivalent of MapLibre's two-pass halo).
//
// Uniforms layout matches packUniforms() in text-renderer.ts (64 B): viewport
// at 0, fill_color at 16 (vec4 alignment pads the 8 B gap after viewport).

import {
  entryFn, bindingRef, vec4, f32, max, smoothstep, textureSample,
  module, structT, f32T, vec2fT, vec4fT, texture2dfT, samplerT,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'viewport', type: vec2fT },
    { name: 'fill_color', type: vec4fT },
    { name: 'halo_color', type: vec4fT },
    { name: 'halo_width', type: f32T },
    { name: 'halo_blur', type: f32T },
    { name: 'font_size_px', type: f32T },
    { name: '_pad1', type: f32T },
  ],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'clip_pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}

const u = bindingRef('u', structT('Uniforms'))
const atlasTex = bindingRef('atlas_tex', texture2dfT)
const atlasSmp = bindingRef('atlas_smp', samplerT)

const vs = entryFn('vs', 'vertex', [
  { name: 'pos_px', type: vec2fT, location: 0 },
  { name: 'uv', type: vec2fT, location: 1 },
], structT('VsOut'), (b, p) => {
  const vp = u.field('viewport', vec2fT)
  const ndc_x = b.let('ndc_x', p.pos_px.x.div(vp.x).mul(2).sub(1))
  const ndc_y = b.let('ndc_y', f32(1).sub(p.pos_px.y.div(vp.y).mul(2)))
  const out = b.var('out', structT('VsOut'))
  b.assign(out.field('clip_pos', vec4fT), vec4(ndc_x, ndc_y, f32(0), f32(1)))
  b.assign(out.field('uv', vec2fT), p.uv)
  b.ret(out)
})

const fs = entryFn('fs', 'fragment', [{ name: 'in', type: structT('VsOut') }], vec4fT, (b, p) => {
  const sdf = b.let('sdf', textureSample(atlasTex, atlasSmp, p.in.field('uv', vec2fT)).r)
  const fill = u.field('fill_color', vec4fT)
  const halo = u.field('halo_color', vec4fT)
  const edge = b.let('edge', f32(0.75))
  const soft = b.let('soft', max(f32(2.52).div(max(u.field('font_size_px', f32T), f32(1))), f32(1).div(255)))
  const fillA = b.let('fill_a', smoothstep(edge.sub(soft), edge.add(soft), sdf))
  // No halo: fill only (premultiplied).
  b.if(u.field('halo_width', f32T).le(0), (c) => {
    c.ret(vec4(fill.rgb, fill.a.mul(fillA)))
  })
  // Halo behind fill: smoothstep at the inward-shifted halo edge, then the
  // (1 - fill_w) factor masks the region the fill already covers.
  const haloEdge = b.let('halo_edge', edge.sub(u.field('halo_width', f32T)))
  const aaHalo = b.let('aa_halo', u.field('halo_blur', f32T).add(soft))
  const haloA = b.let('halo_a', smoothstep(haloEdge.sub(aaHalo), haloEdge.add(aaHalo), sdf))
  const fillW = b.let('fill_w', fill.a.mul(fillA))
  const haloW = b.let('halo_w', halo.a.mul(haloA).mul(f32(1).sub(fillW)))
  b.ret(vec4(fill.rgb.mul(fillW).add(halo.rgb.mul(haloW)), fillW.add(haloW)))
}, '@location(0)')

export const TEXT_MODULE: ModuleDecl = module({
  structs: [Uniforms, VsOut],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'atlas_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'atlas_smp', space: 'uniform', type: samplerT },
  ],
  funcs: [vs, fs],
})

export const emitTextWgsl = (): string => emitModule(TEXT_MODULE)

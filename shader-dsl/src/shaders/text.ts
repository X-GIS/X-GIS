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
  fn, vec4, f32, max, smoothstep, textureSample, select,
  module, f32T, vec2fT, vec4fT, texture2dfT, samplerT,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  viewport: vec2fT,
  fill_color: vec4fT,
  halo_color: vec4fT,
  halo_width: f32T,
  halo_blur: f32T,
  font_size_px: f32T,
  _pad1: f32T,
})
const VsOut = ioStruct('VsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const atlasTex = resource('atlas_tex', texture2dfT, { group: 0, binding: 1 })
const atlasSmp = resource('atlas_smp', samplerT, { group: 0, binding: 2 })

const vs = fn('vs', {
  pos_px: location(0, vec2fT),
  uv: location(1, vec2fT),
}, VsOut.type, (p, _b) => {
  const vp = U.field.viewport
  const ndc_x = p.pos_px.x.div(vp.x).mul(2).sub(1)
  const ndc_y = f32(1).sub(p.pos_px.y.div(vp.y).mul(2))
  return VsOut.construct({
    clip_pos: vec4(ndc_x, ndc_y, 0, 1),
    uv: p.uv,
  })
}, { stage: 'vertex' })

const fs = fn('fs', { in: VsOut.type }, vec4fT, (p, _b) => {
  const sdf = textureSample(atlasTex.node, atlasSmp.node, VsOut.of(p.in).uv).r
  const fill = U.field.fill_color
  const halo = U.field.halo_color
  const edge = f32(0.75)
  const soft = max(f32(2.52).div(max(U.field.font_size_px, 1)), f32(1).div(255))
  const fillA = smoothstep(edge.sub(soft), edge.add(soft), sdf)
  const fillOnly = vec4(fill.rgb, fill.a.mul(fillA))
  // Halo behind fill: smoothstep at the inward-shifted halo edge, then the
  // (1 - fill_w) factor masks the region the fill already covers.
  const haloEdge = edge.sub(U.field.halo_width)
  const aaHalo = U.field.halo_blur.add(soft)
  const haloA = smoothstep(haloEdge.sub(aaHalo), haloEdge.add(aaHalo), sdf)
  const fillW = fill.a.mul(fillA)
  const haloW = halo.a.mul(haloA).mul(f32(1).sub(fillW))
  const withHalo = vec4(fill.rgb.mul(fillW).add(halo.rgb.mul(haloW)), fillW.add(haloW))
  // single-exit: no halo (halo_width<=0) → fill only; else halo behind fill.
  return select(U.field.halo_width.le(0), fillOnly, withHalo)
}, { stage: 'fragment', retAttr: '@location(0)' })

export const TEXT_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding, atlasTex.binding, atlasSmp.binding],
  funcs: [vs, fs],
})

export const emitTextWgsl = (): string => emitModule(TEXT_MODULE)

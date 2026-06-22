// ═══ Shader DSL — icon/sprite shader (Phase 2: textured render shader) ═══
//
// Re-authors sprite/icon-renderer.ts ICON_SHADER_WGSL. Exercises the texture IR
// surface: texture_2d<f32> + sampler bindings, textureSample, fwidth, vertex
// @location inputs, a bare @location(0) fragment return, and .rgb/.a swizzles.
// SDF sprites antialias via fwidth (screen-space, GPU-only); raster sprites are
// a straight sample. No pick variant (the icon shader has no __PICK__ markers).
//
// Single-source-of-truth: every struct + binding is declared ONCE (ioStruct /
// uniformStruct / resource) and the StructDecl, binding decl, access node, attrs,
// and typed field access are all derived — no hand-written StructDecl, binding
// table, attr string, or `.field('name', type)` that must agree by hand.

import {
  fn, vec4, f32, max, smoothstep, fwidth, textureSample, select,
  module, f32T, vec2fT, vec3fT, vec4fT, texture2dfT, samplerT,
  Let,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  viewport: vec2fT,
  _pad0: f32T,
  _pad1: f32T,
})
const VsOut = ioStruct('VsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  opacity: location(1, f32T),
  tint: location(2, vec3fT),
  sdf: location(3, f32T, 'flat'),
})
const atlasTex = resource('atlas_tex', texture2dfT, { group: 0, binding: 1 })
const atlasSmp = resource('atlas_smp', samplerT, { group: 0, binding: 2 })

const vs = fn('vs', {
  pos_px: location(0, vec2fT),
  uv: location(1, vec2fT),
  opacity: location(2, f32T),
  tint: location(3, vec3fT),
  sdf: location(4, f32T),
}, VsOut.type, (p, _b) => {
  const vp = U.field.viewport
  const ndc_x = p.pos_px.x.div(vp.x).mul(2).sub(1)
  const ndc_y = f32(1).sub(p.pos_px.y.div(vp.y).mul(2))
  return VsOut.construct({
    clip_pos: vec4(ndc_x, ndc_y, f32(0), f32(1)),
    uv: p.uv,
    opacity: p.opacity,
    tint: p.tint,
    sdf: p.sdf,
  })
}, { stage: 'vertex' })

const fs = fn('fs', { in: VsOut.type }, vec4fT, (p, _b) => {
  const pin = VsOut.of(p.in)
  const c = textureSample(atlasTex.node, atlasSmp.node, pin.uv)
  // fwidth must be in uniform control flow — compute aa unconditionally (the
  // raster path discards it).
  const dForAa = c.a
  // MUST stay an explicit Let — fwidth is a derivative requiring UNIFORM control flow; inlining
  // would push fwidth() into the SDF-vs-raster select branch (non-uniform) and fail validation.
  const aa = Let('aa', max(fwidth(dForAa), f32(1e-4)))
  // single-exit: SDF sprite (sdf>0.5) uses fwidth-AA coverage; raster sprite straight-samples.
  const cov = smoothstep(f32(0.5).sub(aa), f32(0.5).add(aa), c.a)
  const sdfColor = vec4(pin.tint, cov.mul(pin.opacity))
  const rasterColor = vec4(c.rgb, c.a.mul(pin.opacity))
  return select(pin.sdf.gt(0.5), sdfColor, rasterColor)
}, { stage: 'fragment', retAttr: '@location(0)' })

export const ICON_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding, atlasTex.binding, atlasSmp.binding],
  funcs: [vs, fs],
})

export const emitIconWgsl = (): string => emitModule(ICON_MODULE)

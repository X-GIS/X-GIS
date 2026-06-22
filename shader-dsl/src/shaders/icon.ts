// ═══ Shader DSL — icon/sprite shader (Phase 2: textured render shader) ═══
//
// Re-authors sprite/icon-renderer.ts ICON_SHADER_WGSL. Exercises the texture IR
// surface: texture_2d<f32> + sampler bindings, textureSample, fwidth, vertex
// @location inputs, a bare @location(0) fragment return, and .rgb/.a swizzles.
// SDF sprites antialias via fwidth (screen-space, GPU-only); raster sprites are
// a straight sample. No pick variant (the icon shader has no __PICK__ markers).

import {
  entryFn, bindingRef, vec4, f32, max, smoothstep, fwidth, textureSample, select,
  module, structT, f32T, vec2fT, vec3fT, vec4fT, texture2dfT, samplerT,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'viewport', type: vec2fT },
    { name: '_pad0', type: f32T },
    { name: '_pad1', type: f32T },
  ],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'clip_pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
    { name: 'opacity', type: f32T, attr: '@location(1)' },
    { name: 'tint', type: vec3fT, attr: '@location(2)' },
    { name: 'sdf', type: f32T, attr: '@location(3) @interpolate(flat)' },
  ],
}

const u = bindingRef('u', structT('Uniforms'))
const atlasTex = bindingRef('atlas_tex', texture2dfT)
const atlasSmp = bindingRef('atlas_smp', samplerT)

const vs = entryFn('vs', 'vertex', [
  { name: 'pos_px', type: vec2fT, location: 0 },
  { name: 'uv', type: vec2fT, location: 1 },
  { name: 'opacity', type: f32T, location: 2 },
  { name: 'tint', type: vec3fT, location: 3 },
  { name: 'sdf', type: f32T, location: 4 },
], structT('VsOut'), (b, p) => {
  const vp = u.field('viewport', vec2fT)
  const ndc_x = b.let('ndc_x', p.pos_px.x.div(vp.x).mul(2).sub(1))
  const ndc_y = b.let('ndc_y', f32(1).sub(p.pos_px.y.div(vp.y).mul(2)))
  const out = b.var('out', structT('VsOut'))
  b.assign(out.field('clip_pos', vec4fT), vec4(ndc_x, ndc_y, f32(0), f32(1)))
  b.assign(out.field('uv', vec2fT), p.uv)
  b.assign(out.field('opacity', f32T), p.opacity)
  b.assign(out.field('tint', vec3fT), p.tint)
  b.assign(out.field('sdf', f32T), p.sdf)
  b.ret(out)
})

const fs = entryFn('fs', 'fragment', [{ name: 'in', type: structT('VsOut') }], vec4fT, (b, p) => {
  const c = b.let('c', textureSample(atlasTex, atlasSmp, p.in.field('uv', vec2fT)))
  // fwidth must be in uniform control flow — compute aa unconditionally (the
  // raster path discards it).
  const dForAa = b.let('d_for_aa', c.a)
  const aa = b.let('aa', max(fwidth(dForAa), f32(1e-4)))
  // single-exit: SDF sprite (sdf>0.5) uses fwidth-AA coverage; raster sprite straight-samples.
  const cov = b.let('cov', smoothstep(f32(0.5).sub(aa), f32(0.5).add(aa), c.a))
  const sdfColor = vec4(p.in.field('tint', vec3fT), cov.mul(p.in.field('opacity', f32T)))
  const rasterColor = vec4(c.rgb, c.a.mul(p.in.field('opacity', f32T)))
  return select(p.in.field('sdf', f32T).gt(0.5), sdfColor, rasterColor)
}, '@location(0)')

export const ICON_MODULE: ModuleDecl = module({
  structs: [Uniforms, VsOut],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'atlas_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'atlas_smp', space: 'uniform', type: samplerT },
  ],
  funcs: [vs, fs],
})

export const emitIconWgsl = (): string => emitModule(ICON_MODULE)

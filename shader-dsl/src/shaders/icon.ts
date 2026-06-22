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
  Let, Var, assign,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'viewport', type: vec2fT },
    { name: '_pad0', type: f32T },
    { name: '_pad1', type: f32T },
  ],
}
// SoT: one declaration → the StructDecl (with attrs), the type, and typed field access.
const VsOut = ioStruct('VsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  opacity: location(1, f32T),
  tint: location(2, vec3fT),
  sdf: location(3, f32T, 'flat'),
})

const u = bindingRef('u', structT('Uniforms'))
const atlasTex = bindingRef('atlas_tex', texture2dfT)
const atlasSmp = bindingRef('atlas_smp', samplerT)

const vs = entryFn('vs', 'vertex', [
  { name: 'pos_px', type: vec2fT, location: 0 },
  { name: 'uv', type: vec2fT, location: 1 },
  { name: 'opacity', type: f32T, location: 2 },
  { name: 'tint', type: vec3fT, location: 3 },
  { name: 'sdf', type: f32T, location: 4 },
], VsOut.type, (_b, p) => {
  const vp = u.field('viewport', vec2fT)
  const ndc_x = Let('ndc_x', p.pos_px.x.div(vp.x).mul(2).sub(1))
  const ndc_y = Let('ndc_y', f32(1).sub(p.pos_px.y.div(vp.y).mul(2)))
  const out = Var('out', VsOut.type)
  const o = VsOut.of(out)
  assign(o.clip_pos, vec4(ndc_x, ndc_y, f32(0), f32(1)))
  assign(o.uv, p.uv)
  assign(o.opacity, p.opacity)
  assign(o.tint, p.tint)
  assign(o.sdf, p.sdf)
  return out
})

const fs = entryFn('fs', 'fragment', [{ name: 'in', type: VsOut.type }], vec4fT, (_b, p) => {
  const pin = VsOut.of(p.in)
  const c = Let('c', textureSample(atlasTex, atlasSmp, pin.uv))
  // fwidth must be in uniform control flow — compute aa unconditionally (the
  // raster path discards it).
  const dForAa = Let('d_for_aa', c.a)
  const aa = Let('aa', max(fwidth(dForAa), f32(1e-4)))
  // single-exit: SDF sprite (sdf>0.5) uses fwidth-AA coverage; raster sprite straight-samples.
  const cov = Let('cov', smoothstep(f32(0.5).sub(aa), f32(0.5).add(aa), c.a))
  const sdfColor = vec4(pin.tint, cov.mul(pin.opacity))
  const rasterColor = vec4(c.rgb, c.a.mul(pin.opacity))
  return select(pin.sdf.gt(0.5), sdfColor, rasterColor)
}, '@location(0)')

export const ICON_MODULE: ModuleDecl = module({
  structs: [Uniforms, VsOut.decl],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'atlas_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'atlas_smp', space: 'uniform', type: samplerT },
  ],
  funcs: [vs, fs],
})

export const emitIconWgsl = (): string => emitModule(ICON_MODULE)

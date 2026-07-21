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
  fn,
  vec4,
  f32,
  max,
  smoothstep,
  fwidth,
  textureSample,
  select,
  module,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
  texture2dfT,
  samplerT,
  Let,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, stageOf } from '@xgis/shader-dsl'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    viewport: vec2fT,
    // #1177 S16 replay correction (see text.ts twin): screen-space affine
    // applied on skip-replay frames; identity (1, 0,0) on prepared frames.
    // Struct grows 16→32 B — icon-renderer.ts uniformBuf/uniformScratch match.
    replay_shift: vec2fT,
    replay_scale: f32T,
    _pad0: f32T,
    _pad1: f32T,
    _pad2: f32T,
  },
)
const VsOut = ioStruct('VsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  opacity: location(1, f32T),
  tint: location(2, vec3fT),
  sdf: location(3, f32T, 'flat'),
})
const atlasTex = resource('atlas_tex', texture2dfT, { group: 0, binding: 1 })
const atlasSmp = resource('atlas_smp', samplerT, { group: 0, binding: 2 })

const vs = fn(
  'vs',
  {
    pos_px: location(0, vec2fT),
    uv: location(1, vec2fT),
    opacity: location(2, f32T),
    tint: location(3, vec3fT),
    sdf: location(4, f32T),
  },
  (p) => {
    const vp = U.field.viewport
    // #1177 replay correction — text.ts twin: map PREPARED-frame screen px
    // into the CURRENT frame on S16 skip-replay frames.
    const px_x = p.pos_px.x.mul(U.field.replay_scale).add(U.field.replay_shift.x)
    const px_y = p.pos_px.y.mul(U.field.replay_scale).add(U.field.replay_shift.y)
    const ndc_x = px_x.div(vp.x).mul(2).sub(1)
    const ndc_y = f32(1).sub(px_y.div(vp.y).mul(2))
    return VsOut.construct({
      clip_pos: vec4(ndc_x, ndc_y, 0, 1),
      uv: p.uv,
      opacity: p.opacity,
      tint: p.tint,
      sdf: p.sdf,
    })
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs',
  { in: VsOut },
  (p) => {
    const pin = p.in
    const c = textureSample(atlasTex.node, atlasSmp.node, pin.uv)
    // fwidth must be in uniform control flow — compute aa unconditionally (the
    // raster path discards it).
    const dForAa = c.a
    // MUST stay an explicit Let — fwidth is a derivative requiring UNIFORM control flow; inlining
    // would push fwidth() into the SDF-vs-raster select branch (non-uniform) and fail validation.
    const aa = Let(max(fwidth(dForAa), 1e-4))
    // single-exit: SDF sprite (sdf>0.5) uses fwidth-AA coverage; raster sprite straight-samples.
    const cov = smoothstep(f32(0.5).sub(aa), f32(0.5).add(aa), c.a)
    const sdfColor = vec4(pin.tint, cov.mul(pin.opacity))
    const rasterColor = vec4(c.rgb, c.a.mul(pin.opacity))
    return select(pin.sdf.gt(0.5), sdfColor, rasterColor)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const ICON_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding, atlasTex.binding, atlasSmp.binding],
  funcs: [vs, fs],
})

export const emitIconWgsl = (): string => emitModule(ICON_MODULE)

/** GLSL ES 3.00 twin (#834 M5 slice 4 — mirrors emitTextGlsl). Single-main-
 *  per-stage split; fwidth is core in ES 3.00, no extension needed. */
export const emitIconGlsl = (stage: 'vertex' | 'fragment'): string => {
  const keep = stage === 'vertex' ? 'vs' : 'fs'
  return emitGlslModule(
    {
      ...ICON_MODULE,
      funcs: ICON_MODULE.funcs.filter((f) => stageOf(f) === undefined || f.name === keep),
    },
    stage,
  )
}

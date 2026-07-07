// ═══ Translucent-line compositor shader (fullscreen triangle) ═══
//
// Extracted from line.ts (the arch ratchet caps that file; the compositor is
// a standalone assembly concern anyway — different bind group + a single
// opacity uniform). Samples the MAX-blend offscreen RT and composites onto
// the main framebuffer with per-layer opacity. Pairs with pipelineMax /
// LineCompositeDraper; the GLSL twin is assembled per stage by
// emitCompositeGlsl (line-glsl.ts) from this module's parts.

import {
  fn,
  module,
  emitModule,
  uniformStruct,
  ioStruct,
  builtin,
  location,
  resource,
  texture2dfT,
  samplerT,
  f32T,
  vec3fT,
  vec2fT,
  vec4fT,
  u32T,
  vec2,
  vec4,
  If,
  textureSample,
  type ModuleDecl,
} from '@xgis/shader-dsl'

const CompUniform = uniformStruct(
  'CompUniform',
  { group: 0, binding: 2, as: 'cu' },
  {
    opacity: f32T,
    _pad: vec3fT,
  },
)

const VsFullOut = ioStruct('VsFullOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const compSampB = resource('samp', samplerT, { group: 0, binding: 0 })
const compSamp = compSampB.node
const compSrcB = resource('src', texture2dfT, { group: 0, binding: 1 })
const compSrc = compSrcB.node

export const vsFull = fn(
  'vs_full',
  { vi: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    const uv = vec2(0, 1)
    If(p.vi.eq(1), () => {
      pos.assign(vec2(3, -1))
      uv.assign(vec2(2, 1))
    })
    If(p.vi.eq(2), () => {
      pos.assign(vec2(-1, 3))
      uv.assign(vec2(0, -1))
    })
    return VsFullOut.construct({
      pos: vec4(pos, 0, 1),
      uv,
    })
  },
  { stage: 'vertex' },
)

/** GL twin of vs_full with the V axis flipped. WebGPU textures put v=0 at the
 *  top row, and clip y=-1 is the screen bottom, so vs_full maps bottom→v=1.
 *  A GL FBO stores clip y=-1 at texture ROW 0 and samples it at v=0 — reusing
 *  the WGSL uv constants on WebGL2 composited the whole offscreen RT
 *  VERTICALLY MIRRORED (masked in the s6 gate by its vertically-centred band;
 *  visible on OFM Bright as building_top/highway_area stroke tint landing on
 *  the wrong half of the frame). Same fn NAME so the Material vsEntry and the
 *  emitted GLSL entry stay 'vs_full'. */
export const vsFullGl = fn(
  'vs_full',
  { vi: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    const uv = vec2(0, 0)
    If(p.vi.eq(1), () => {
      pos.assign(vec2(3, -1))
      uv.assign(vec2(2, 0))
    })
    If(p.vi.eq(2), () => {
      pos.assign(vec2(-1, 3))
      uv.assign(vec2(0, 2))
    })
    return VsFullOut.construct({
      pos: vec4(pos, 0, 1),
      uv,
    })
  },
  { stage: 'vertex' },
)

export const fsFull = fn(
  'fs_full',
  { input: VsFullOut },
  (p) => {
    const c = textureSample(compSrc, compSamp, p.input.uv)
    const op = CompUniform.field.opacity
    // MAX-blend offscreen stores non-premultiplied (rgb, a_aa); premultiply here.
    return vec4(c.rgb.mul(c.a).mul(op), c.a.mul(op))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const compositeModule: ModuleDecl = module({
  structs: [CompUniform.struct, VsFullOut.decl],
  bindings: [compSampB.binding, compSrcB.binding, CompUniform.binding],
  funcs: [vsFull, fsFull],
})

/** Translucent-line compositor: fullscreen triangle that samples the max-blend
 *  offscreen RT and composites onto the main framebuffer with per-layer
 *  opacity. Pairs with pipelineMax in line-renderer.ts. */
export const emitCompositeWgsl = (): string => emitModule(compositeModule)

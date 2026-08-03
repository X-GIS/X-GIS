// ═══ Scene→screen upscale shader (fullscreen triangle) — #1429 INC-2 ═══
//
// Samples the RESOLVED scene colour (single-sample, scene-sized) through a
// FILTERING sampler and writes it straight into the screen attachment, so a
// ladder-scaled scene reads as a resolution scale and not a mosaic. No
// uniforms, no blend — the seam replaces every pixel (the first screen-side
// writer of a scaled frame). Dual-emit: the WGSL authority plus a per-stage
// GLSL twin (same discipline as line-composite), because the Inc-4 flip runs
// the ONE chain on WebGL2 and this pass rides the chain.

import {
  fn,
  module,
  emitModule,
  emitGlslModule,
  ioStruct,
  builtin,
  location,
  resource,
  texture2dfT,
  samplerT,
  vec2fT,
  vec4fT,
  u32T,
  vec2,
  vec4,
  If,
  textureSample,
  type ModuleDecl,
} from '@xgis/shader-dsl'

const VsUpscaleOut = ioStruct('VsUpscaleOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const upSampB = resource('samp', samplerT, { group: 0, binding: 0 })
const upSamp = upSampB.node
const upSrcB = resource('src', texture2dfT, { group: 0, binding: 1 })
const upSrc = upSrcB.node

export const vsUpscale = fn(
  'vs_upscale',
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
    return VsUpscaleOut.construct({
      pos: vec4(pos, 0, 1),
      uv,
    })
  },
  { stage: 'vertex' },
)

/** GL twin with the V axis flipped — the same lesson as line-composite's
 *  vsFullGl: a GL FBO stores clip y=-1 at texture ROW 0 (sampled at v=0),
 *  the inverse of WebGPU's v=0-at-top, so reusing the WGSL uv constants on
 *  WebGL2 would upscale the scene vertically mirrored. Same fn NAME so the
 *  Material vsEntry and the emitted GLSL entry stay 'vs_upscale'. */
export const vsUpscaleGl = fn(
  'vs_upscale',
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
    return VsUpscaleOut.construct({
      pos: vec4(pos, 0, 1),
      uv,
    })
  },
  { stage: 'vertex' },
)

export const fsUpscale = fn(
  'fs_upscale',
  { input: VsUpscaleOut },
  (p) => textureSample(upSrc, upSamp, p.input.uv),
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const sceneUpscaleModule: ModuleDecl = module({
  structs: [VsUpscaleOut.decl],
  bindings: [upSampB.binding, upSrcB.binding],
  funcs: [vsUpscale, fsUpscale],
})

/** Scene→screen upscale: fullscreen triangle sampling the resolved scene
 *  colour through a filtering sampler. Pairs with SceneUpscaleDraper. */
export const emitSceneUpscaleWgsl = (): string => emitModule(sceneUpscaleModule)

/** GLSL ES 3.00 twin — per-stage assembly reusing the WGSL authority module's
 *  structs/bindings verbatim (vsUpscaleGl for the FBO V-flip). */
export const emitSceneUpscaleGlsl = (stage: 'vertex' | 'fragment'): string =>
  emitGlslModule(
    module({
      structs: sceneUpscaleModule.structs,
      bindings: sceneUpscaleModule.bindings,
      funcs: [stage === 'vertex' ? vsUpscaleGl : fsUpscale],
    }),
    stage,
  )

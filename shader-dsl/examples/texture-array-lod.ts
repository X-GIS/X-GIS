// ═══ @xgis/shader-dsl example — 2d-array texture, sampled per LAYER (#1651) ═══
//
// A tile/glyph ATLAS as one `texture_2d_array<f32>` binding: N layers behind a single
// binding slot, with the layer chosen per SAMPLE instead of per bind group. The three
// array reads the DSL exposes all appear here:
//
//   • textureSample(tex, smp, uv, layer)               — filtered, implicit LOD
//                                                        (FRAGMENT-only, like its 2d twin)
//   • textureSampleLevel(tex, smp, uv, layer, level)   — filtered, EXPLICIT LOD (any stage)
//   • textureLoad(tex, coord, layer, level)            — unfiltered texel fetch
//
// Each carries its own NEUTRAL intrinsic id, because the two targets restructure the
// arguments rather than merely adding one: WGSL appends the layer
// (`textureSample(t, s, uv, layer)`), GLSL ES 3.00 folds it into the coordinate
// (`texture(sampler2DArray, vec3(uv, float(layer)))`).
//
// NOT WebGL2-renderable (`renderable: false`) — not a backend limit (2d-array is CORE
// GLSL ES 3.00, sampler2DArray, and needs no Capability), but a HARNESS one: the site's
// live runner binds one UBO and the fp64 guard texture, and has no way to supply an
// atlas. The site shows its WGSL + reflection (whose texture entry now names
// `textureDim: '2d-array'`); the real-WebGL2 compile + per-layer readback lives in
// playground/e2e/_glsl-texture-array-gate.spec.ts.

import {
  fn,
  module,
  vec2,
  vec2i,
  vec4,
  f32,
  u32,
  mix,
  u32T,
  vec2fT,
  vec4fT,
  If,
  ioStruct,
  builtin,
  location,
  resource,
  samplerT,
  texture2dArrayfT,
  textureSample,
  textureSampleLevel,
  textureLoad,
} from '../src/index.js'
import type { ShaderExample } from './_shared.js'

// One binding for the whole atlas — the layer is an argument, not a bind-group switch.
const atlas = resource('atlas', texture2dArrayfT, { group: 0, binding: 0 })
const atlasSampler = resource('atlas_sampler', samplerT, { group: 0, binding: 1 })

// Which layer holds what. Plain numbers: a `number` layer lifts to an i32 literal
// (WGSL's array_index is i32/u32 — an f32 `0.0` there is a type error).
const LAYER_BASE = 0
const LAYER_DETAIL = 1

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// Oversized fullscreen triangle (3 verts, NDC −1..3) — no vertex buffer.
const vsFull = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    return VsOut.construct({
      pos: vec4(pos, 0, 1),
      uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
    })
  },
  { stage: 'vertex' },
)

// Fragment — cross-fade the base layer (implicit LOD) into a coarse mip of the detail
// layer (explicit LOD), tinted by an unfiltered corner texel of the base layer.
const fsAtlas = fn(
  'fs_atlas',
  { vo: VsOut },
  (p) => {
    const base = textureSample(atlas.node, atlasSampler.node, p.vo.uv, LAYER_BASE)
    const detail = textureSampleLevel(atlas.node, atlasSampler.node, p.vo.uv, LAYER_DETAIL, 2)
    const corner = textureLoad(atlas.node, vec2i(0, 0), LAYER_BASE, u32(0))
    return vec4(mix(base.rgb, detail.rgb, p.vo.uv.x).mul(corner.a), f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const textureArrayModule = module({
  structs: [VsOut.decl],
  bindings: [atlas.binding, atlasSampler.binding],
  funcs: [vsFull, fsAtlas],
})

export const textureArrayLod: ShaderExample = {
  id: 'texture-array-lod',
  title: '2D array texture',
  blurb:
    'A tile atlas as ONE `texture_2d_array<f32>` binding — the layer is a per-sample argument, not a bind-group switch. Shows all three array reads (implicit-LOD sample, explicit-LOD sample, unfiltered load); WGSL appends the layer, GLSL folds it into a `vec3` coordinate on a `sampler2DArray`.',
  category: 'generic',
  file: 'texture-array-lod.ts',
  module: textureArrayModule,
  renderable: false,
}

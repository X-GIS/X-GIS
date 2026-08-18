// ═══ Translucent-extrude SHELL compositor (fullscreen triangle) — #1253 ═══
//
// The second half of the LAYER-WIDE front shell. The shell pass resolved the
// front-MOST extruded surface per pixel across EVERY tile of one layer into an
// offscreen colour target with blending OFF, so a pixel covered by two tiles
// holds ONE surface colour instead of two stacked blends (#1080's per-draw
// front shell could only do that within a single tile's draw). This fullscreen
// triangle is the ONE place that colour reaches the scene, blended once at the
// layer's resolved fill alpha.
//
// WHY THE ALPHA RIDES A UNIFORM instead of the texel's own alpha: under MSAA
// the shell target is hardware-resolved before it is sampled, so a silhouette
// pixel with coverage `cov` holds the straight-alpha average of its covered and
// its cleared samples — (rgb·cov, a·cov). The correct composite is
// dst·(1 − a·cov) + rgb·(a·cov), i.e. a PREMULTIPLIED source (rgb·a·cov, a·cov).
// Reading `a` back out of the texel yields rgb·a·cov² — a dark fringe on every
// silhouette. Multiplying rgb by the layer alpha (a scalar the CPU already
// resolved: bucket-scheduler's `extrudeFillAlpha`, the same value #1080 gates
// on) reconstructs the premultiplied source exactly, at cov = 1 and below. The
// colour target therefore blends 'premult'.
//
// Non-polygon-variant — independent emit; no ShaderVariant fields touched.

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

/** The layer's resolved fill alpha. Its OWN group (1) because the draper binds
 *  it through the Material's per-item pool — two translucent-extrude layers in
 *  one frame composite at two different alphas, and a single shared buffer
 *  would hand both draws whichever value was written last (WebGPU's
 *  `writeBuffer` is deferred to submit; the line compositor's ring exists for
 *  exactly this reason). */
const ShellUniform = uniformStruct(
  'ShellUniform',
  { group: 1, binding: 0, as: 'su' },
  {
    alpha: f32T,
    _pad: vec3fT,
  },
)

const VsShellOut = ioStruct('VsShellOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const shellSampB = resource('samp', samplerT, { group: 0, binding: 0 })
const shellSrcB = resource('src', texture2dfT, { group: 0, binding: 1 })

/** Oversized fullscreen triangle (3 vertices, NDC −1..3). v = 1 at clip
 *  y = −1: WebGPU texture origin is top-left while NDC's is bottom-left, the
 *  same mapping the line compositor's `vs_full` uses. */
const vsShell = fn(
  'vs_shell',
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
    return VsShellOut.construct({ pos: vec4(pos, 0, 1), uv })
  },
  { stage: 'vertex' },
)

const fsShell = fn(
  'fs_shell',
  { input: VsShellOut },
  (p) => {
    const c = textureSample(shellSrcB.node, shellSampB.node, p.input.uv)
    // Premultiply by the LAYER alpha (see the header): rgb·a·cov from the
    // resolved rgb·cov, alpha straight through as a·cov. Uncovered pixels
    // sample the (0,0,0,0) clear and contribute nothing.
    return vec4(c.rgb.mul(ShellUniform.field.alpha), c.a)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const extrudeShellComposeModule: ModuleDecl = module({
  structs: [ShellUniform.struct, VsShellOut.decl],
  bindings: [shellSampB.binding, shellSrcB.binding, ShellUniform.binding],
  funcs: [vsShell, fsShell],
})

/** Translucent-extrude shell compositor: a fullscreen triangle that samples the
 *  resolved shell target and composites it onto the scene colour at the layer's
 *  fill alpha. Pairs with `ExtrudeShellComposeDraper` + the shell variants of
 *  `buildExtrudeMaterial`. */
export const emitExtrudeShellComposeWgsl = (): string => emitModule(extrudeShellComposeModule)

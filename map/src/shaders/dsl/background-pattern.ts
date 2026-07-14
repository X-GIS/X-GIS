// ═══ Shader DSL — background-pattern fullscreen fill (#777 I-E) ═══
//
// The background pass's FIRST draw (background-pass.ts). After the coverage
// clear, a fullscreen triangle tiles a sprite over the whole viewport: each
// fragment's screen pixel is wrapped (fract) into the sprite's atlas-UV
// sub-rect, so a single packed atlas texel repeats across the frame without a
// hardware REPEAT sampler (a packed atlas cannot use texture wrap — the sprite
// occupies only a sub-rectangle, so the wrap is analytic here, mirroring the
// fill-/line-pattern fragment in polygon.ts:fs_fill_pattern).
//
// DUAL-SOURCE by construction (#1046 cross-program constraint): this module is
// authored ONCE against the shader-dsl IR; `emitBackgroundPatternWgsl` gives
// the WGSL twin (WebGPU today) and `emitGlslModule(buildBackgroundPatternModule(),
// stage)` the GLSL ES 3.00 twin (WebGL2 once F3/F4 flip the pass) — no
// RHI_TWIN_MISSING. Deliberately NOT wired through pipeline-factory.ts (that
// ceilinged, #1046-contended file) — the background pass owns this pipeline via
// the RHI-typed seam (ctx.rhi.createPipeline).

import {
  fn,
  module,
  vec2,
  vec4,
  fract,
  textureSample,
  uniformStruct,
  ioStruct,
  builtin,
  location,
  resource,
  emitModule,
  Return,
  If,
  vec2fT,
  vec4fT,
  u32T,
  texture2dfT,
  samplerT,
  type ModuleDecl,
} from '@xgis/shader-dsl'

// group 0 uniform: the sprite's atlas-UV bbox + the screen-space tile size.
//   rect   = (u0, v0, u1, v1) — sprite atlas-UV bbox (min/max), the SAME
//            packing polygon fs_fill_pattern reads from u.fill_color.
//   params = (tilePxX, tilePxY, viewportW, viewportH) — all in DEVICE px; the
//            tile size is the sprite's CSS size × dpr, the viewport is w/h.
//   misc   = (opacity, _, _, _) — background-opacity multiplied into the tile.
const U = uniformStruct(
  'BgPattern',
  { group: 0, binding: 0, as: 'u' },
  {
    rect: vec4fT,
    params: vec4fT,
    misc: vec4fT,
  },
)
const atlas = resource('atlas', texture2dfT, { group: 0, binding: 1 })
const atlasSampler = resource('atlas_sampler', samplerT, { group: 0, binding: 2 })

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  // 0..1 across the viewport (the fullscreen triangle's normalised screen
  // position); the fragment scales it to device px via params.zw.
  screen01: location(0, vec2fT),
})

// Oversized fullscreen triangle (3 verts, NDC −1..3), the same no-vertex-buffer
// trick as oit-compose / overdraw compose — the rasterizer clips the half
// outside the viewport, avoiding the 6-vertex bit-packed quad's off-by-vertex.
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
      screen01: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
    })
  },
  { stage: 'vertex' },
)

const fsPattern = fn(
  'fs_pattern',
  { in: VsOut },
  (p) => {
    const rect = U.field.rect
    const params = U.field.params
    // Screen pixel → tile coordinate → wrapped local UV in [0,1) → remap into
    // the sprite's atlas-UV bbox. fract() is the pattern tiling (analytic wrap).
    const px = vec2(p.in.screen01.x.mul(params.z), p.in.screen01.y.mul(params.w))
    const tile = vec2(px.x.div(params.x), px.y.div(params.y))
    const uvLocal = vec2(fract(tile.x), fract(tile.y))
    const atlasUv = vec2(
      rect.x.add(uvLocal.x.mul(rect.z.sub(rect.x))),
      rect.y.add(uvLocal.y.mul(rect.w.sub(rect.y))),
    )
    const c = textureSample(atlas.node, atlasSampler.node, atlasUv)
    // Straight-alpha over the coverage clear (blend 'alpha'); background-opacity
    // multiplies the sprite alpha so a translucent pattern fades the clear.
    Return(vec4(c.rgb, c.a.mul(U.field.misc.x)))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const backgroundPatternModule: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding, atlas.binding, atlasSampler.binding],
  funcs: [vsFull, fsPattern],
})

/** The authored IR — consumed by the GLSL twin (`emitGlslModule(m, 'vertex' |
 *  'fragment')`) so the WebGL2 backend links the SAME graph the WGSL emits. */
export const buildBackgroundPatternModule = (): ModuleDecl => backgroundPatternModule

/** WGSL twin: `vs_full` + `fs_pattern` in one module (WebGPU pipeline source). */
export const emitBackgroundPatternWgsl = (): string => emitModule(backgroundPatternModule)

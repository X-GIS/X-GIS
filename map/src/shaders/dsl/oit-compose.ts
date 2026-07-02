// ═══ Shader DSL — OIT compose (Phase 4+ migration) ═══
//
// Re-authors the OIT (weighted-blended translucent) compose pass
// previously inlined in renderer.ts:1085. Fullscreen triangle samples
// the accum + revealage textures and over-blends the recovered
// translucent colour onto the (resolved) main framebuffer.
//
// MSAA-aware: when sampleCount > 1, the accum + revealage textures are
// multisampled and the shader averages every sample to recover a single
// resolved value. Single-sample (mobile / safe mode) takes the same
// code path with a 1-sample loop, no branch. The DSL emit picks the
// right binding type via `texture2dMsfT` vs `texture2dfT`.
//
// Non-polygon-variant — independent emit; no ShaderVariant fields touched.

import {
  fn, module,
  f32, i32, vec2, vec4, toF32, toI32,
  textureLoad, textureDimensions, vec2i,
  u32T, vec2fT, vec4fT,
  texture2dfT, texture2dMsfT,
  max,
  Let, If, Loop, Return,
  type Node, type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// Oversized fullscreen triangle (3 vertices, NDC −1..3 in each axis).
// Same trick as the overdraw compose pass — covers the whole screen
// with no vertex buffer + a single triangle (rasterizer clips the half
// outside the viewport). Avoids the off-by-vertex bug of the bit-
// packed 6-vertex quad pattern.

const vsFull = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
      .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
    // Texture coords are sample-load coords (integer pixels) computed from clip-space NDC:
    // uv = (pos + 1) / 2, y flipped because the texture origin is top-left while NDC's is bottom-left.
    return VsOut.construct({
      pos: vec4(pos, 0, 1),
      uv: vec2(
        pos.x.add(1).mul(0.5),
        f32(1).sub(pos.y.add(1).mul(0.5)),
      ),
    })
  },
  { stage: 'vertex' },
)

// Build fs_compose with the sample-count loop trip-count baked in as
// an integer literal. WGSL accepts an i32 literal as the loop bound
// directly — no module-level const needed.

const buildFsCompose = (sampleCount: number, accumTex: Node, revealageTex: Node) => {
  return fn(
    'fs_compose',
    { in: VsOut },
    (p) => {
      // textureDimensions returns vec2<u32>; toF32 each component for the
      // uv → texel-coord multiply. WGSL doesn't auto-convert across
      // signed/unsigned/float in vec construction, so the conversion is
      // explicit.
      const dimU = textureDimensions(accumTex)
      const dim = vec2(toF32(dimU.x), toF32(dimU.y))
      const inUv = p.in.uv
      const uv = vec2i(toI32(inUv.x.mul(dim.x)), toI32(inUv.y.mul(dim.y)))
      const accumSum = vec4(0, 0, 0, 0)
      const revSum = f32(0)
      Loop(i32(0), (s) => s.lt(i32(sampleCount)), (s) => {
        accumSum.assign(accumSum.add(textureLoad(accumTex, uv, s)))
        revSum.assign(revSum.add(textureLoad(revealageTex, uv, s).x))
      })
      const inv = f32(1).div(f32(sampleCount))
      const accum = Let(accumSum.mul(inv))
      const revealage = Let(revSum.mul(inv))
      const avg = accum.rgb.div(max(accum.w, 1e-5))
      const alpha = f32(1).sub(revealage)
      Return(vec4(avg, alpha))
    },
    { stage: 'fragment', retAttr: '@location(0)' },
  )
}

/** OIT compose pipeline's full WGSL source. Drop-in for the inline
 *  wgsl-tag template renderer.ts:1085 previously held; the pipeline
 *  still creates the same shader module + bind-group layout.
 *
 *  `sampleCount` is the multisample trip count (1 = single-sample, 2/4
 *  = MSAA). `isMsaa` selects the binding type — `texture_multisampled_2d`
 *  when true, `texture_2d` when false. */
export const emitOitComposeWgsl = (sampleCount: number, isMsaa: boolean): string => {
  const texType = isMsaa ? texture2dMsfT : texture2dfT
  const accumTexB = resource('accum_tex', texType, { group: 0, binding: 0 })
  const revealageTexB = resource('revealage_tex', texType, { group: 0, binding: 1 })
  const oitComposeModule: ModuleDecl = module({
    structs: [VsOut.decl],
    bindings: [accumTexB.binding, revealageTexB.binding],
    funcs: [vsFull, buildFsCompose(sampleCount, accumTexB.node, revealageTexB.node)],
  })
  return emitModule(oitComposeModule)
}

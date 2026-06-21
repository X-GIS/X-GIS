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
  entryFn, module, bindingRef,
  f32, u32, i32, vec2, vec4, toF32, toI32,
  textureLoad, textureDimensions, vec2i,
  f32T, u32T, vec2fT, vec4fT,
  texture2dfT, texture2dMsfT,
  structT, max,
  type ShaderType, type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}

// Oversized fullscreen triangle (3 vertices, NDC −1..3 in each axis).
// Same trick as the overdraw compose pass — covers the whole screen
// with no vertex buffer + a single triangle (rasterizer clips the half
// outside the viewport). Avoids the off-by-vertex bug of the bit-
// packed 6-vertex quad pattern.

const vsFull = entryFn(
  'vs_full', 'vertex',
  [{ name: 'idx', type: u32T, builtin: 'vertex_index' }],
  structT('VsOut'),
  (b, p) => {
    const pos = b.var('pos', vec2fT, vec2(f32(-1), f32(-1)))
    b.if(p.idx.eq(u32(1)), (c) => { c.assign(pos, vec2(f32(3), f32(-1))) })
      .elif(p.idx.eq(u32(2)), (c) => { c.assign(pos, vec2(f32(-1), f32(3))) })
    const out = b.var('out', structT('VsOut'))
    b.assign(out.field('pos', vec4fT), vec4(pos, f32(0), f32(1)))
    // Texture coords are sample-load coords (integer pixels) computed
    // from clip-space NDC: uv = (pos + 1) / 2, y flipped because the
    // texture origin is top-left while NDC's is bottom-left.
    b.assign(out.field('uv', vec2fT),
      vec2(
        pos.x.add(f32(1)).mul(f32(0.5)),
        f32(1).sub(pos.y.add(f32(1)).mul(f32(0.5))),
      ),
    )
    b.ret(out)
  },
)

// Build fs_compose with the sample-count loop trip-count baked in as
// an integer literal. WGSL accepts an i32 literal as the loop bound
// directly — no module-level const needed.

const buildFsCompose = (sampleCount: number, texType: ShaderType) => {
  const accumTex = bindingRef('accum_tex', texType)
  const revealageTex = bindingRef('revealage_tex', texType)
  return entryFn(
    'fs_compose', 'fragment',
    [{ name: 'in', type: structT('VsOut') }],
    vec4fT,
    (b, p) => {
      // textureDimensions returns vec2<u32>; toF32 each component for the
      // uv → texel-coord multiply. WGSL doesn't auto-convert across
      // signed/unsigned/float in vec construction, so the conversion is
      // explicit.
      const dimU = b.let('dim_u', textureDimensions(accumTex))
      const dim = b.let('dim', vec2(toF32(dimU.x), toF32(dimU.y)))
      const inUv = p.in.field('uv', vec2fT)
      const uv = b.let('uv', vec2i(toI32(inUv.x.mul(dim.x)), toI32(inUv.y.mul(dim.y))))
      const accumSum = b.var('accum_sum', vec4fT, vec4(f32(0), f32(0), f32(0), f32(0)))
      const revSum = b.var('rev_sum', f32T, f32(0))
      b.forRange('s', i32(0), (s) => s.lt(i32(sampleCount)), (cb, s) => {
        cb.assignOp(accumSum, '+', textureLoad(accumTex, uv, s))
        cb.assignOp(revSum, '+', textureLoad(revealageTex, uv, s).x)
      })
      const inv = b.let('inv', f32(1).div(f32(sampleCount)))
      const accum = b.let('accum', accumSum.mul(inv))
      const revealage = b.let('revealage', revSum.mul(inv))
      const avg = b.let('avg', accum.rgb.div(max(accum.w, f32(1e-5))))
      const alpha = b.let('alpha', f32(1).sub(revealage))
      b.ret(vec4(avg, alpha))
    },
    '@location(0)',
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
  const oitComposeModule: ModuleDecl = module({
    structs: [VsOut],
    bindings: [
      { group: 0, binding: 0, name: 'accum_tex', space: 'uniform', type: texType },
      { group: 0, binding: 1, name: 'revealage_tex', space: 'uniform', type: texType },
    ],
    funcs: [vsFull, buildFsCompose(sampleCount, texType)],
  })
  return emitModule(oitComposeModule)
}

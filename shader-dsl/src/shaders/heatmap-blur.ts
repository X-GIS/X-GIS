// ═══ Shader DSL — heatmap separable Gaussian blur pass (Phase R) ═══
//
// Pass 2 of the 3-pass heatmap pipeline (accum → blur → compose). The raw
// accumulation texture is a sum of hard-edged Gaussian splats; a separable
// Gaussian blur smooths it into the continuous density field the colour
// ramp reads. "Separable" = a 2-D Gaussian factors into a horizontal 1-D
// pass followed by a vertical 1-D pass, so two of THIS pipeline run per
// frame with a `direction` uniform of (1,0) then (0,1).
//
// This is the FIRST blur primitive in the codebase. It is a standalone
// fullscreen-triangle pass (same oversized-triangle trick as the OIT /
// overdraw compose passes) that reads the R16Float density via textureLoad
// (integer texel coords — the accum target is `unfilterable-float`, so no
// filterable sampler is needed, mirroring overdraw-compose.ts) and writes
// the weighted 9-tap Gaussian back to an R16Float target.
//
// 9-tap kernel (σ≈2 px, normalised): the weights are the standard binomial
// approximation [0.227, 0.194, 0.121, 0.054, 0.016] for taps at 0,±1,±2,
// ±3,±4 texels. Stepping 1 texel per tap in the `direction` axis gives a
// ~σ2 blur per pass; two separable passes compose to a 2-D Gaussian.

import {
  entryFn, module, bindingRef,
  f32, u32, vec2, vec4, toF32, toI32, clamp,
  textureLoad, textureDimensions, vec2i,
  u32T, vec2fT, vec4fT, texture2dfT,
  structT,
  Var, Let, assign, If,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const Params: StructDecl = {
  name: 'BlurParams',
  fields: [
    // direction: (1,0) horizontal pass, (0,1) vertical pass. zw unused.
    { name: 'direction', type: vec4fT },
  ],
}

const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}

const srcTex = bindingRef('src_tex', texture2dfT)
const params = bindingRef('p', structT('BlurParams'))

// Oversized fullscreen triangle (NDC −1..3) — same trick as overdraw-compose.
const vsFull = entryFn(
  'vs_full', 'vertex',
  [{ name: 'idx', type: u32T, builtin: 'vertex_index' }],
  structT('VsOut'),
  (_b, p) => {
    const pos = Var('pos', vec2fT, vec2(f32(-1), f32(-1)))
    If(p.idx.eq(u32(1)), () => { assign(pos, vec2(f32(3), f32(-1))) })
      .elif(p.idx.eq(u32(2)), () => { assign(pos, vec2(f32(-1), f32(3))) })
    const out = Var('out', structT('VsOut'))
    assign(out.field('pos', vec4fT), vec4(pos, f32(0), f32(1)))
    // y-flip — texture origin top-left, NDC origin bottom-left.
    assign(out.field('uv', vec2fT),
      vec2(
        pos.x.add(f32(1)).mul(f32(0.5)),
        f32(1).sub(pos.y.add(f32(1)).mul(f32(0.5))),
      ),
    )
    return out
  },
)

// fs_blur — 9-tap separable Gaussian along `direction`. Reads the R16Float
// density with textureLoad (clamped to the texture extent at the edges).
const fsBlur = entryFn(
  'fs_blur', 'fragment',
  [{ name: 'in', type: structT('VsOut') }],
  vec4fT,
  (_b, p) => {
    const dimU = Let('dim_u', textureDimensions(srcTex))
    const dim = Let('dim', vec2(toF32(dimU.x), toF32(dimU.y)))
    const baseUv = Let('base_uv', p.in.field('uv', vec2fT))
    const baseX = Let('base_x', baseUv.x.mul(dim.x))
    const baseY = Let('base_y', baseUv.y.mul(dim.y))
    const dir = Let('dir', params.field('direction', vec4fT))
    const maxX = Let('max_x', toF32(dimU.x).sub(f32(1)))
    const maxY = Let('max_y', toF32(dimU.y).sub(f32(1)))

    // sample(offset) — load one texel at +offset texels along `direction`,
    // clamped to the texture extent.
    const sampleAt = (offset: number) => {
      const sx = Let(`sx_${offset < 0 ? 'm' : 'p'}${Math.abs(offset)}`,
        clamp(baseX.add(dir.x.mul(f32(offset))), f32(0), maxX))
      const sy = Let(`sy_${offset < 0 ? 'm' : 'p'}${Math.abs(offset)}`,
        clamp(baseY.add(dir.y.mul(f32(offset))), f32(0), maxY))
      const coord = Let(`c_${offset < 0 ? 'm' : 'p'}${Math.abs(offset)}`,
        vec2i(toI32(sx), toI32(sy)))
      return textureLoad(srcTex, coord, u32(0)).x
    }

    // 9-tap binomial Gaussian weights (sum = 1).
    const w0 = 0.2270270270
    const w1 = 0.1945945946
    const w2 = 0.1216216216
    const w3 = 0.0540540541
    const w4 = 0.0162162162

    const acc = Let('acc',
      sampleAt(0).mul(f32(w0))
        .add(sampleAt(1).mul(f32(w1)))
        .add(sampleAt(-1).mul(f32(w1)))
        .add(sampleAt(2).mul(f32(w2)))
        .add(sampleAt(-2).mul(f32(w2)))
        .add(sampleAt(3).mul(f32(w3)))
        .add(sampleAt(-3).mul(f32(w3)))
        .add(sampleAt(4).mul(f32(w4)))
        .add(sampleAt(-4).mul(f32(w4))),
    )
    return vec4(acc, f32(0), f32(0), f32(1))
  },
  '@location(0)',
)

const HEATMAP_BLUR_MODULE: ModuleDecl = module({
  structs: [Params, VsOut],
  bindings: [
    { group: 0, binding: 0, name: 'src_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 1, name: 'p', space: 'uniform', type: structT('BlurParams') },
  ],
  funcs: [vsFull, fsBlur],
})

/** Heatmap separable-Gaussian blur shader (one direction per draw; the pass
 *  runs it twice with direction=(1,0) then (0,1)). */
export const emitHeatmapBlurWgsl = (): string => emitModule(HEATMAP_BLUR_MODULE)

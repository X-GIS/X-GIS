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
  fn, module,
  f32, u32, vec2, vec4, toF32, toI32, clamp,
  textureLoad, textureDimensions, vec2i,
  u32T, vec2fT, vec4fT, texture2dfT,
  Var, If,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'

const Params = uniformStruct('BlurParams', { group: 0, binding: 1, as: 'p' }, {
  // direction: (1,0) horizontal pass, (0,1) vertical pass. zw unused.
  direction: vec4fT,
})

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const srcTex = resource('src_tex', texture2dfT, { group: 0, binding: 0 })

// Oversized fullscreen triangle (NDC −1..3) — same trick as overdraw-compose.
const vsFull = fn(
  'vs_full', { idx: builtin('vertex_index', u32T) },
  VsOut.type,
  (p, _b) => {
    const pos = Var(vec2(f32(-1), f32(-1)))
    If(p.idx.eq(1), () => { pos.assign(vec2(f32(3), f32(-1))) })
      .elif(p.idx.eq(2), () => { pos.assign(vec2(f32(-1), f32(3))) })
    const out = Var(VsOut.type)
    const o = VsOut.of(out)
    o.pos.assign(vec4(pos, f32(0), f32(1)))
    // y-flip — texture origin top-left, NDC origin bottom-left.
    o.uv.assign(vec2(
        pos.x.add(1).mul(0.5),
        f32(1).sub(pos.y.add(1).mul(0.5)),
      ))
    return out
  },
  { stage: 'vertex' },
)

// fs_blur — 9-tap separable Gaussian along `direction`. Reads the R16Float
// density with textureLoad (clamped to the texture extent at the edges).
const fsBlur = fn(
  'fs_blur', { in: VsOut.type },
  vec4fT,
  (p, _b) => {
    const dimU = textureDimensions(srcTex.node)
    const dim = vec2(toF32(dimU.x), toF32(dimU.y))
    const baseUv = VsOut.of(p.in).uv
    const baseX = baseUv.x.mul(dim.x)
    const baseY = baseUv.y.mul(dim.y)
    const dir = Params.field.direction
    const maxX = toF32(dimU.x).sub(1)
    const maxY = toF32(dimU.y).sub(1)

    // sample(offset) — load one texel at +offset texels along `direction`,
    // clamped to the texture extent.
    const sampleAt = (offset: number) => {
      const sx = clamp(baseX.add(dir.x.mul(f32(offset))), f32(0), maxX)
      const sy = clamp(baseY.add(dir.y.mul(f32(offset))), f32(0), maxY)
      const coord = vec2i(toI32(sx), toI32(sy))
      return textureLoad(srcTex.node, coord, u32(0)).x
    }

    // 9-tap binomial Gaussian weights (sum = 1).
    const w0 = 0.2270270270
    const w1 = 0.1945945946
    const w2 = 0.1216216216
    const w3 = 0.0540540541
    const w4 = 0.0162162162

    const acc = sampleAt(0).mul(f32(w0))
        .add(sampleAt(1).mul(f32(w1)))
        .add(sampleAt(-1).mul(f32(w1)))
        .add(sampleAt(2).mul(f32(w2)))
        .add(sampleAt(-2).mul(f32(w2)))
        .add(sampleAt(3).mul(f32(w3)))
        .add(sampleAt(-3).mul(f32(w3)))
        .add(sampleAt(4).mul(f32(w4)))
        .add(sampleAt(-4).mul(f32(w4)))
    return vec4(acc, f32(0), f32(0), f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const HEATMAP_BLUR_MODULE: ModuleDecl = module({
  structs: [Params.struct, VsOut.decl],
  bindings: [srcTex.binding, Params.binding],
  funcs: [vsFull, fsBlur],
})

/** Heatmap separable-Gaussian blur shader (one direction per draw; the pass
 *  runs it twice with direction=(1,0) then (0,1)). */
export const emitHeatmapBlurWgsl = (): string => emitModule(HEATMAP_BLUR_MODULE)

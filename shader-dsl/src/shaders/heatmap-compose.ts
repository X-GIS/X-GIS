// ═══ Shader DSL — heatmap compose pass (Phase R) ═══
//
// Pass 3 of the 3-pass heatmap pipeline (accum → blur → compose). A
// fullscreen triangle samples the blurred R16Float density, normalises it
// to a 0..1 ramp coordinate (× `heatmap-intensity`), maps that coordinate
// through the `heatmap-color` ramp (a CPU-baked 256×1 RGBA LUT the renderer
// uploads), multiplies the result by `heatmap-opacity`, and alpha-blends
// over the scene (the pipeline binds a standard src-alpha blend so the
// heatmap composites on top of the already-rendered map).
//
// Bindings:
//   0 = density_tex   R16Float accum (unfilterable-float → textureLoad)
//   1 = ramp_tex      256×1 RGBA8 colour LUT (filterable → textureSample)
//   2 = ramp_sampler  linear-filter sampler for the LUT
//   3 = u             ComposeParams { intensity, opacity, _pad2 }
//
// The density→ramp-coordinate is `clamp(density · intensity, 0, 1)`. Mapbox
// applies heatmap-intensity as a multiplier on the accumulated density and
// then the colour ramp is keyed on the normalised `heatmap-density` in
// 0..1 — so the compose just scales by intensity and clamps. The ramp's
// alpha channel (Mapbox's convention: the ramp starts at rgba(0,0,0,0) so
// zero density is transparent) carries the per-density opacity, multiplied
// by the layer-level heatmap-opacity.

import {
  entryFn, module, bindingRef, callFn, fn,
  Let, Var, assign, If,
  f32, u32, vec2, vec4, toF32, toI32, clamp,
  textureLoad, textureSample, textureDimensions, vec2i,
  f32T, u32T, vec2fT, vec4fT, texture2dfT, samplerT,
  structT,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const ComposeParams: StructDecl = {
  name: 'ComposeParams',
  fields: [
    // x = intensity (heatmap-intensity), y = opacity (heatmap-opacity), zw pad.
    { name: 'params', type: vec4fT },
  ],
}

const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}

const densityTex = bindingRef('density_tex', texture2dfT)
const rampTex = bindingRef('ramp_tex', texture2dfT)
const rampSampler = bindingRef('ramp_sampler', samplerT)
const u = bindingRef('u', structT('ComposeParams'))

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

// load_density — fetch the blurred density at this pixel's texel coord.
const loadDensity = fn('load_density', { uv: vec2fT }, f32T, (_b, p) => {
  const dimU = Let('dim_u', textureDimensions(densityTex))
  const dim = Let('dim', vec2(toF32(dimU.x), toF32(dimU.y)))
  const coord = Let('coord', vec2i(
    toI32(p.uv.x.mul(dim.x)),
    toI32(p.uv.y.mul(dim.y)),
  ))
  return textureLoad(densityTex, coord, u32(0)).x
})

const fsCompose = entryFn(
  'fs_compose', 'fragment',
  [{ name: 'in', type: structT('VsOut') }],
  vec4fT,
  (_b, p) => {
    const density = Let('density', callFn('load_density', f32T, p.in.field('uv', vec2fT)))
    const intensity = Let('intensity', u.field('params', vec4fT).x)
    const opacity = Let('opacity', u.field('params', vec4fT).y)
    // Normalise density → ramp coordinate (0..1) via intensity scale.
    const t = Let('t', clamp(density.mul(intensity), f32(0), f32(1)))
    // Sample the colour ramp LUT at (t, 0.5). The ramp's own alpha encodes
    // the per-density transparency (Mapbox ramp starts transparent at 0).
    const ramp = Let('ramp', textureSample(rampTex, rampSampler, vec2(t, f32(0.5))))
    const a = Let('a', ramp.a.mul(opacity))
    return vec4(ramp.rgb, a)
  },
  '@location(0)',
)

const HEATMAP_COMPOSE_MODULE: ModuleDecl = module({
  structs: [ComposeParams, VsOut],
  bindings: [
    { group: 0, binding: 0, name: 'density_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 1, name: 'ramp_tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'ramp_sampler', space: 'uniform', type: samplerT },
    { group: 0, binding: 3, name: 'u', space: 'uniform', type: structT('ComposeParams') },
  ],
  funcs: [loadDensity, vsFull, fsCompose],
})

/** Heatmap compose shader: samples blurred density, maps through the colour
 *  ramp LUT × intensity × opacity, alpha-blends over the scene. */
export const emitHeatmapComposeWgsl = (): string => emitModule(HEATMAP_COMPOSE_MODULE)

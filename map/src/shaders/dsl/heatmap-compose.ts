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
  module, fn,
  Var, If,
  f32, u32, vec2, vec4, toF32, toI32, clamp,
  textureLoad, textureSample, textureDimensions, vec2i,
  u32T, vec2fT, vec4fT, texture2dfT, samplerT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'

const U = uniformStruct('ComposeParams', { group: 0, binding: 3, as: 'u' }, {
  // x = intensity (heatmap-intensity), y = opacity (heatmap-opacity), zw pad.
  params: vec4fT,
})

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const densityTex = resource('density_tex', texture2dfT, { group: 0, binding: 0 })
const rampTex = resource('ramp_tex', texture2dfT, { group: 0, binding: 1 })
const rampSampler = resource('ramp_sampler', samplerT, { group: 0, binding: 2 })

// Oversized fullscreen triangle (NDC −1..3) — same trick as overdraw-compose.
const vsFull = fn(
  'vs_full', { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = Var(vec2(-1, -1))
    If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
      .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
    const o = VsOut.var()
    o.pos.assign(vec4(pos, 0, 1))
    // y-flip — texture origin top-left, NDC origin bottom-left.
    o.uv.assign(vec2(
        pos.x.add(1).mul(0.5),
        f32(1).sub(pos.y.add(1).mul(0.5)),
      ))
    return o.$
  },
  { stage: 'vertex' },
)

// load_density — fetch the blurred density at this pixel's texel coord.
const loadDensity = fn('load_density', { uv: vec2fT }, (p) => {
  const dimU = textureDimensions(densityTex.node)
  const dim = vec2(toF32(dimU.x), toF32(dimU.y))
  const coord = vec2i(
    toI32(p.uv.x.mul(dim.x)),
    toI32(p.uv.y.mul(dim.y)),
  )
  return textureLoad(densityTex.node, coord, u32(0)).x
})

const fsCompose = fn(
  'fs_compose', { in: VsOut },
  (p) => {
    const density = loadDensity(p.in.uv)
    const intensity = U.field.params.x
    const opacity = U.field.params.y
    // Normalise density → ramp coordinate (0..1) via intensity scale.
    const t = clamp(density.mul(intensity), 0, 1)
    // Sample the colour ramp LUT at (t, 0.5). The ramp's own alpha encodes
    // the per-density transparency (Mapbox ramp starts transparent at 0).
    const ramp = textureSample(rampTex.node, rampSampler.node, vec2(t, 0.5))
    const a = ramp.a.mul(opacity)
    return vec4(ramp.rgb, a)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const HEATMAP_COMPOSE_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [densityTex.binding, rampTex.binding, rampSampler.binding, U.binding],
  funcs: [loadDensity, vsFull, fsCompose],
})

/** Heatmap compose shader: samples blurred density, maps through the colour
 *  ramp LUT × intensity × opacity, alpha-blends over the scene. */
export const emitHeatmapComposeWgsl = (): string => emitModule(HEATMAP_COMPOSE_MODULE)

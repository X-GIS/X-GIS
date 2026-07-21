// ═══ Shader DSL — S-100 coverage colour-ramp arm (#1158 GAP-1 INC-A) ═══
//
// A raster-pipeline variant (NOT the heatmap accumulator): two r16float data
// textures + a 256×1 rgba8 LUT drawn over the coverage's outer-cell-edge quad,
// flat Mercator. Dual-emit (WGSL + GLSL) through the shader-dsl so the WebGL2 twin
// lands from day one (#775). The two texel-level differences from image-raster:
//
//   1. INVERSE-MERCATOR ROW MAPPING (A4 — the flaw the doc misses). The coverage grid
//      is linear-in-LATITUDE (EPSG:4326) but the draw quad is Mercator-conformal, so
//      a linear V over the quad misplaces rows by ~0.7 texel at 56°N. Instead the
//      vertex passes the interpolated Mercator-Y varying and the FRAGMENT recovers
//      latitude per pixel — lat = 2·atan(exp(mercY))−π/2 (the Gudermannian; the exact
//      equivalent of atan(sinh(mercY)), spellable with the portable atan/exp) — then
//      v = (latNorthEdge − lat) / (nLat·dLat). Linear-V is NEVER used.
//   2. VALIDITY-WEIGHTED SAMPLING (A3). texValue stores f16(s·valid), texValid stores
//      f16(valid). One linear tap each; w = validSample; w<1/512 ⇒ fully transparent;
//      else s' = valueSample / w — an exact validity-weighted bilinear so nodata never
//      contaminates neighbour values (NaN-texel / in-band-sentinel encodings are
//      forbidden). alpha *= w gives a ≤1-texel soft rim. t = clamp(a·s'+b) samples the
//      LUT (a,b are CPU-side range→[0,1] uniforms).
//
// Gate 3 (headed real-GPU readback) cannot run in this environment, so the formula
// is pinned NOW by a dsl-emission test asserting both WGSL and GLSL contain the
// inverse-Mercator expression and the validity-weighted division (A4).

import {
  fn,
  module,
  transformMat4,
  arrayLit,
  f32,
  u32,
  toF32,
  vec2,
  vec4,
  mix,
  atan,
  exp,
  log,
  tan,
  clamp,
  textureSample,
  radians,
  degrees,
  f32T,
  u32T,
  vec4fT,
  mat4x4fT,
  texture2dfT,
  samplerT,
  If,
  Discard,
  type ModuleDecl,
  type ReadonlyNode,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import { project, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { PI } from './consts'

const U = uniformStruct(
  'CoverageUniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    mvp: mat4x4fT,
    // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
    proj_params: vec4fT,
    // xy = camera Mercator centre (the flat MVP is camera-at-origin); zw reserved.
    cam_center: vec4fT,
    // outer cell EDGES (degrees): x=westLon, y=southLat, z=eastLon, w=northLat.
    cov_edges: vec4fT,
    // u/v denominators: x=westLonEdge, y=northLatEdge, z=nLon·dLon, w=nLat·dLat.
    cov_geo: vec4fT,
    // ramp map t = clamp(a·s' + b): x=a=(dataMax−dataMin)/(rangeHi−rangeLo),
    // y=b=(dataMin−rangeLo)/(rangeHi−rangeLo); zw reserved.
    ramp_params: vec4fT,
  },
)
export { U as coverageU }

const VsOut = ioStruct('CovVsOut', {
  pos: builtin('position', vec4fT),
  lon: location(0, f32T),
  merc_y: location(1, f32T),
})

// Two data textures + the LUT, each with a REFLECTION NAME (WebGL2 binds
// multi-same-kind groups by name, rhi.ts #783; the raster arm's single
// texture/sampler could bind by order, this cannot).
const texValue = resource('cov_value', texture2dfT, { group: 0, binding: 1 })
const texValid = resource('cov_valid', texture2dfT, { group: 0, binding: 2 })
const covSampler = resource('cov_sampler', samplerT, { group: 0, binding: 3 })
const texLut = resource('cov_lut', texture2dfT, { group: 0, binding: 4 })
const lutSampler = resource('cov_lut_sampler', samplerT, { group: 0, binding: 5 })

/** Raw Mercator-Y of a latitude (radians): ln(tan(π/4 + lat/2)). Linear in screen
 *  space for a flat-Mercator quad, so the rasterizer interpolates it correctly and
 *  the fragment inverts it per-pixel (A4). */
const mercatorY = (latRad: ReadonlyNode<'f32'>) => log(tan(PI.div(4).add(latRad.div(2))))

const vs = fn(
  'vs_cov',
  { vid: builtin('vertex_index', u32T) },
  (p) => {
    // 2 triangles over the 4 outer-edge corners (u01,v01 ∈ {0,1}²).
    const duArr = arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0))
    const dvArr = arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1))
    const u01 = toF32(duArr.at(p.vid, u32T))
    const v01 = toF32(dvArr.at(p.vid, u32T))

    const edges = U.field.cov_edges
    const lon = mix(edges.x, edges.z, u01) // west→east
    const latDeg = mix(edges.y, edges.w, v01) // south→north
    const latRad = radians(latDeg)

    // Flat-Mercator projection (mirrors the raster flat arm): project → 2D metres,
    // camera-relative, MVP. The globe drape path is INC-B.
    const p2d = project(lon, latDeg, U.field.proj_params)
    const rel = p2d.sub(vec2(U.field.cam_center.x, U.field.cam_center.y))
    const clip = transformMat4(U.field.mvp, vec4(rel.x, rel.y, f32(0), f32(1)))

    return VsOut.construct({ pos: clip, lon, merc_y: mercatorY(latRad) })
  },
  { stage: 'vertex' },
)

const CovFragOut = ioStruct('CovFragOut', { color: location(0, vec4fT) })

const fs = fn(
  'fs_cov',
  { input: VsOut },
  (p) => {
    const pin = p.input
    // A4 — recover latitude from the INTERPOLATED Mercator-Y (never a linear V):
    // lat = 2·atan(exp(mercY)) − π/2 (Gudermannian = atan(sinh(mercY))).
    const latRad = f32(2)
      .mul(atan(exp(pin.merc_y)))
      .sub(PI.div(2))
    const latDeg = degrees(latRad)
    const geo = U.field.cov_geo
    const vTex = geo.y.sub(latDeg).div(geo.w) // (northLatEdge − lat)/(nLat·dLat)
    const uTex = pin.lon.sub(geo.x).div(geo.z) // (lon − westLonEdge)/(nLon·dLon)
    const uv = vec2(uTex, vTex)

    // A3 — validity-weighted bilinear: one linear tap per texture.
    const valueSample = textureSample(texValue.node, covSampler.node, uv).x
    const w = textureSample(texValid.node, covSampler.node, uv).x
    If(w.lt(f32(1).div(f32(512))), () => {
      Discard()
    })
    const sPrime = valueSample.div(w) // nodata never contaminates neighbour values
    const t = clamp(U.field.ramp_params.x.mul(sPrime).add(U.field.ramp_params.y), f32(0), f32(1))
    const rgb = textureSample(texLut.node, lutSampler.node, vec2(t, f32(0.5))).xyz
    // alpha = w gives the ≤1-texel soft rim at a hole boundary.
    return CovFragOut.construct({ color: vec4(rgb.x, rgb.y, rgb.z, w) })
  },
  { stage: 'fragment' },
)

export const buildCoverageModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [U.struct, VsOut.decl, CovFragOut.decl],
    bindings: [
      U.binding,
      texValue.binding,
      texValid.binding,
      covSampler.binding,
      texLut.binding,
      lutSampler.binding,
    ],
    funcs: [...getGpuProjectionFuncs(), vs, fs],
  })

/** Full coverage-ramp shader (WGSL). `emitGlslModule(buildCoverageModule(), stage)`
 *  gives the WebGL2 twin. */
export const emitCoverageWgsl = (): string => emitModule(buildCoverageModule())

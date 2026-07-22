// ═══ Shader DSL — S-100 coverage colour-ramp arm (#1158 GAP-1 / INC-B step 1) ═══
//
// A raster-pipeline variant (NOT the heatmap accumulator): two r16float data textures
// + a 256×1 rgba8 LUT drawn over the coverage's footprint, as a TESSELLATED SURFACE
// GRID — mirroring the raster surface-grid VS (raster.ts). Dual-emit (WGSL + GLSL)
// through the shader-dsl so the WebGL2 twin lands from day one (#775).
//
// PROJECTION-GENERAL BY TESSELLATION (the fix for the Mercator-only bake). INC-A drew a
// SINGLE quad and recovered latitude per-fragment via the inverse Mercator (Gudermannian)
// — correct ONLY under Mercator, so the coverage misplaced rows under every other flat
// projection (Natural Earth / Equirectangular / …) and did not draw on the globe at all.
// Instead we now emit an N×N grid (COVERAGE_GRID_N) and project EACH vertex through the
// general `project()` (the same int-dispatch raster/vector use). Fine tessellation makes
// the linear interpolation of lon/lat across each sub-quad sub-texel for ANY flat
// projection, so the fragment reads its UV straight from the interpolated geographic
// coords — no baked Mercator inverse. (The globe drape via proj_globe/ECEF is INC-B
// step 2, still gated `!globeMode` at the opaque-pass arm.)
//
// The other texel-level concern, unchanged from INC-A:
//   VALIDITY-WEIGHTED SAMPLING (A3). texValue stores f16(s·valid), texValid stores
//   f16(valid). One linear tap each; w = validSample; w<1/512 ⇒ fully transparent; else
//   s' = valueSample / w — an exact validity-weighted bilinear so nodata never
//   contaminates neighbour values. alpha *= w gives a ≤1-texel soft rim.
//
// Gate 3 (headed real-GPU readback) cannot run in this environment, so the shape is
// pinned NOW by a dsl-emission test asserting both WGSL and GLSL tessellate + project
// per-vertex and read UV from the interpolated coords (coverage-ramp.test.ts).

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
  clamp,
  textureSample,
  f32T,
  u32T,
  vec4fT,
  mat4x4fT,
  texture2dfT,
  samplerT,
  If,
  Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import { project, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'

/** Tessellation of the coverage footprint: an N×N grid of cells (2 triangles each). Fine
 *  enough that linear lon/lat interpolation across a sub-quad is sub-texel for any flat
 *  projection — the replacement for the single quad + baked inverse-Mercator. Matches the
 *  upper end of the raster surface grid (rasterGridN caps at 128; a coverage overlay is
 *  ONE draw, not per-tile, so a fixed 64 is cheap: 64·64·6 ≈ 24.6k verts). */
export const COVERAGE_GRID_N = 64

/** Vertex count for the procedural N×N coverage surface grid (6 verts/cell). */
export const coverageGridVertexCount = (): number => COVERAGE_GRID_N * COVERAGE_GRID_N * 6

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
  lat: location(1, f32T),
})

// Two data textures + the LUT, each with a REFLECTION NAME (WebGL2 binds
// multi-same-kind groups by name, rhi.ts #783; the raster arm's single
// texture/sampler could bind by order, this cannot).
const texValue = resource('cov_value', texture2dfT, { group: 0, binding: 1 })
const texValid = resource('cov_valid', texture2dfT, { group: 0, binding: 2 })
const covSampler = resource('cov_sampler', samplerT, { group: 0, binding: 3 })
const texLut = resource('cov_lut', texture2dfT, { group: 0, binding: 4 })
const lutSampler = resource('cov_lut_sampler', samplerT, { group: 0, binding: 5 })

const vs = fn(
  'vs_cov',
  { vid: builtin('vertex_index', u32T) },
  (p) => {
    // Procedural N×N surface grid (6 verts/cell, from vertex_index — no vertex buffer),
    // the same decode the raster surface-grid VS uses.
    const cell = p.vid.div(u32(6))
    const tri = p.vid.mod(u32(6))
    const cx = cell.mod(u32(COVERAGE_GRID_N))
    const cy = cell.div(u32(COVERAGE_GRID_N))
    // 2 triangles over the cell's 4 corners (u01,v01 ∈ {0,1}² within the cell).
    const duArr = arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0))
    const dvArr = arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1))
    const gx = cx.add(duArr.at(tri, u32T))
    const gy = cy.add(dvArr.at(tri, u32T))
    const u01 = toF32(gx).div(f32(COVERAGE_GRID_N)) // 0→1 west→east across the footprint
    const v01 = toF32(gy).div(f32(COVERAGE_GRID_N)) // 0→1 south→north

    const edges = U.field.cov_edges
    const lon = mix(edges.x, edges.z, u01) // west→east
    const latDeg = mix(edges.y, edges.w, v01) // south→north

    // Per-vertex FLAT projection (mirrors the raster surface-grid arm): project each grid
    // vertex → 2D metres, camera-relative, MVP. Fine tessellation makes the interpolated
    // lon/lat sub-texel for EVERY flat projection — no baked Mercator. The globe drape
    // (proj_globe / ECEF) is INC-B step 2.
    const p2d = project(lon, latDeg, U.field.proj_params)
    const rel = p2d.sub(vec2(U.field.cam_center.x, U.field.cam_center.y))
    const clip = transformMat4(U.field.mvp, vec4(rel.x, rel.y, f32(0), f32(1)))

    return VsOut.construct({ pos: clip, lon, lat: latDeg })
  },
  { stage: 'vertex' },
)

const CovFragOut = ioStruct('CovFragOut', { color: location(0, vec4fT) })

const fs = fn(
  'fs_cov',
  { input: VsOut },
  (p) => {
    const pin = p.input
    // UV straight from the INTERPOLATED geographic coords — projection-general because the
    // grid is finely tessellated (no inverse-Mercator row recovery).
    const geo = U.field.cov_geo
    const uTex = pin.lon.sub(geo.x).div(geo.z) // (lon − westLonEdge)/(nLon·dLon)
    const vTex = geo.y.sub(pin.lat).div(geo.w) // (northLatEdge − lat)/(nLat·dLat)
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

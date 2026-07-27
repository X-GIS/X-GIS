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
// projection. (The globe drape via proj_globe/ECEF is INC-B step 2, still gated
// `!globeMode` at the opaque-pass arm.)
//
// CRS-CORRECT PLACEMENT (#1366 INC-3). The tessellation above still DERIVED each
// vertex's lon/lat as `mix(cov_edges, u01)` — which assumes the footprint is a rectangle
// IN LON/LAT. Real S-102 cells are projected (UTM): the footprint is a rectangle in the
// cell's OWN CRS and its edges curve in lon/lat, so that mix placed them wrongly (and
// the reader refused them rather than mis-render). Node lon/lat is now CPU-reprojected
// per arm (`coverageMeshNodes`, @xgis/data) and arrives as a VERTEX ATTRIBUTE over an
// indexed mesh; uv rides along as a varying instead of being inverted back out of
// geography. No projection math enters this shader, so the CPU keeps sole authority over
// it — a GPU twin of the same math is this codebase's dominant bug archetype (§12).
//
// The other texel-level concern, unchanged from INC-A:
//   VALIDITY-WEIGHTED SAMPLING (A3). texValue stores f16(s·valid), texValid stores
//   f16(valid). One linear tap each; w = validSample; w<1/512 ⇒ fully transparent; else
//   s' = valueSample / w — an exact validity-weighted bilinear so nodata never
//   contaminates neighbour values. alpha *= w gives a ≤1-texel soft rim.
//
// The load-bearing shape is pinned by a dsl-emission test asserting both WGSL and GLSL
// take node lon/lat as an attribute, project per-vertex, and carry uv as a varying
// (coverage-ramp.test.ts).

import {
  fn,
  module,
  transformMat4,
  f32,
  vec2,
  vec4,
  clamp,
  textureSample,
  vec2fT,
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
 *  projection — the replacement for the single quad + baked inverse-Mercator.
 *
 *  N=64 predates the #1366 INC-3 error budget, which measured (on the real NOAA
 *  Chesapeake cell) that the interpolation term is already 43 cm at N=16 and that the
 *  residual floors at ~40 cm from N≈16 onward because node lon/lat reaches the GPU as
 *  f32 (half an ulp at lon ≈ −75.9 ≈ 0.42 m). Past N≈16 a finer mesh buys NOTHING. 64 is
 *  kept here so this increment changes placement only — lowering it is a separate,
 *  independently-gateable change now that the budget is measured. */
export const COVERAGE_GRID_N = 64

/** Mesh NODES — (N+1)² lon/lat vertices. Under 65 536, so the index buffer is uint16. */
export const coverageNodeCount = (): number => (COVERAGE_GRID_N + 1) * (COVERAGE_GRID_N + 1)

/** INDEX count for the N×N coverage surface grid (2 triangles = 6 indices per cell).
 *  The mesh is INDEXED as of #1366 INC-3: nodes carry CPU-reprojected lon/lat, and a
 *  node is shared by up to 6 triangles, so indexing stores each exactly once. */
export const coverageGridIndexCount = (): number => COVERAGE_GRID_N * COVERAGE_GRID_N * 6

const U = uniformStruct(
  'CoverageUniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    mvp: mat4x4fT,
    // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
    proj_params: vec4fT,
    // xy = camera Mercator centre (the flat MVP is camera-at-origin); zw reserved.
    cam_center: vec4fT,
    // `cov_edges` / `cov_geo` (the lon/lat footprint rectangle + the u/v denominators)
    // are GONE as of #1366 INC-3. Both encoded "the footprint is a rectangle in lon/lat",
    // which a projected (UTM) cell violates. Node lon/lat now arrives as a vertex
    // attribute and uv as a varying, so the assumption has no representation left in
    // this block for anything to re-introduce it from.
    // ramp map t = clamp(a·s' + b): x=a=(dataMax−dataMin)/(rangeHi−rangeLo),
    // y=b=(dataMin−rangeLo)/(rangeHi−rangeLo); z=layer opacity (0..1); w reserved.
    ramp_params: vec4fT,
  },
)
export { U as coverageU }

// The only varying is uv. `lon`/`lat` were interpolated so the fragment could RECOVER
// uv from geography; uv is now carried directly — cheaper, and exact for a projected
// grid, where uv is NOT an affine function of lon/lat.
const VsOut = ioStruct('CovVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
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
  {
    // Node lon/lat, CPU-reprojected per arm by `coverageMeshNodes` (@xgis/data). The
    // vertex stage no longer DERIVES geography — it reads it. That is the whole of
    // #1366 INC-3: `mix(cov_edges, u01)` assumed the footprint was a rectangle IN
    // LON/LAT, which a projected (UTM) cell violates, since its edges curve in lon/lat.
    // Reprojecting on the CPU keeps sole authority for the projection there; a GPU twin
    // of the same math is this codebase's dominant bug archetype (CLAUDE.md §12).
    // A GEOGRAPHIC cell gets the identical `mix` arithmetic on the CPU, so its drape is
    // unchanged by construction, not by tolerance.
    node_lonlat: location(0, vec2fT),
    // Footprint fraction of this node, v already flipped to the data texture's north-up
    // row order. Supplied rather than derived because the mesh is now INDEXED — there is
    // no vertex_index to decode a grid position from.
    node_uv: location(1, vec2fT),
  },
  (p) => {
    const lon = p.node_lonlat.x
    const latDeg = p.node_lonlat.y

    // Per-vertex FLAT projection (mirrors the raster surface-grid arm): project each grid
    // vertex → 2D metres, camera-relative, MVP. Fine tessellation makes the interpolated
    // lon/lat sub-texel for EVERY flat projection — no baked Mercator. The globe drape
    // (proj_globe / ECEF) is INC-B step 2.
    const p2d = project(lon, latDeg, U.field.proj_params)
    const rel = p2d.sub(vec2(U.field.cam_center.x, U.field.cam_center.y))
    const clip = transformMat4(U.field.mvp, vec4(rel.x, rel.y, f32(0), f32(1)))

    return VsOut.construct({ pos: clip, uv: p.node_uv })
  },
  { stage: 'vertex' },
)

const CovFragOut = ioStruct('CovFragOut', { color: location(0, vec4fT) })

const fs = fn(
  'fs_cov',
  { input: VsOut },
  (p) => {
    const pin = p.input
    // uv arrives as a varying, already in grid space. It used to be RECOVERED here from
    // the interpolated lon/lat — valid only while uv was affine in lon/lat, i.e. only for
    // a geographic footprint. Carrying it makes the fragment CRS-blind (#1366 INC-3).
    const uv = pin.uv

    // A3 — validity-weighted bilinear: one linear tap per texture.
    const valueSample = textureSample(texValue.node, covSampler.node, uv).x
    const w = textureSample(texValid.node, covSampler.node, uv).x
    If(w.lt(f32(1).div(f32(512))), () => {
      Discard()
    })
    const sPrime = valueSample.div(w) // nodata never contaminates neighbour values
    const t = clamp(U.field.ramp_params.x.mul(sPrime).add(U.field.ramp_params.y), f32(0), f32(1))
    const rgb = textureSample(texLut.node, lutSampler.node, vec2(t, f32(0.5))).xyz
    // alpha = validity·layerOpacity — w gives the ≤1-texel soft rim at a hole boundary,
    // ramp_params.z applies the LAYER's opacity paint (#1158; lets a coverage blend over a
    // basemap, e.g. currents over satellite imagery). Default opacity 1 = unchanged.
    return CovFragOut.construct({ color: vec4(rgb.x, rgb.y, rgb.z, w.mul(U.field.ramp_params.z)) })
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

// ═══ Shader DSL — polygon shader (Phase 2.5 US-007b) ═══
//
// Re-authors render/renderer-shaders.ts POLYGON_SHADER_SOURCE (826 LOC).
// The polygon shader is the variant-codegen-heavy fill / stroke / extrude
// pipeline: 1 Uniforms struct (192 bytes; reused by stroke + extrude paths
// via field aliasing), 3 fixed bindings (u, sprite_atlas, sprite_samp),
// 3 vertex entries (vs_main / vs_main_quantized / vs_main_quantized_extruded)
// and 6 fragment entries (fs_fill / fs_fill_pattern / fs_oit_translucent /
// fs_fill_extrude / fs_stroke / fs_overdraw).
//
// Pattern (line.ts sibling): emitPolygonWgsl(variant, pickEnabled) PREPENDS
// the shared DSL-emitted strings (WGSL_PROJECTION_CONSTS + WGSL_LOG_DEPTH_FNS
// + WGSL_PROJECTION_FNS), then composes the polygon ModuleDecl with the
// variant's preamble + fill/stroke exprs. fs_fill / fs_stroke contain
// placeholder Stmts (tags 'fill-return' / 'stroke-return') that the composer
// swaps with `[...preamble, return expr]` when the variant injects custom
// fill/stroke logic; bare placeholders survive as `// __placeholder: ...`
// comments per US-007a's defensive design.
//
// `pickEnabled` toggles the pick attachment field + writes (replaces the
// old __PICK_FIELD__ / __PICK_WRITE__ regex markers in POLYGON_SHADER_SOURCE).

import {
  entryFn, fn, module, bindingRef, constRef, callFn,
  f32, vec4, toU32, transformMat4, clamp, select,
  f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  structT,
  Node,
  type StructDecl, type StructField, type ModuleDecl, type Stmt,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'
import { PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS } from './projections'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'

// ── Struct declarations ──
//
// Field order + names match POLYGON_SHADER_SOURCE byte-for-byte; the 192-byte
// uniform layout is consumed by every polygon variant + by every per-tile
// uniform writeBuffer caller in renderer.ts / vector-tile-renderer.ts, so any
// reordering would silently mis-bind the GPU read.

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'fill_color', type: vec4fT },
    { name: 'stroke_color', type: vec4fT },
    { name: 'proj_params', type: vec4fT },
    { name: 'cam_h', type: vec2fT },
    { name: 'cam_l', type: vec2fT },
    { name: 'tile_origin_merc', type: vec2fT },
    { name: 'opacity', type: f32T },
    { name: 'log_depth_fc', type: f32T },
    { name: 'pick_id', type: u32T },
    { name: 'layer_depth_offset', type: f32T },
    { name: 'tile_extent_m', type: f32T },
    { name: 'extrude_height_m', type: f32T },
    { name: 'clip_bounds', type: vec4fT },
    { name: 'zoom', type: f32T },
    { name: 'extrude_base_m', type: f32T },
    { name: 'fill_translate_x', type: f32T },
    { name: 'fill_translate_y', type: f32T },
  ],
}

const VertexOutput: StructDecl = {
  name: 'VertexOutput',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'cos_c', type: f32T, attr: '@location(0)' },
    { name: 'feat_id', type: u32T, attr: '@location(1) @interpolate(flat)' },
    { name: 'abs_lat', type: f32T, attr: '@location(2)' },
    { name: 'view_w', type: f32T, attr: '@location(3)' },
    { name: 'wall_blend', type: f32T, attr: '@location(4)' },
    { name: 'abs_merc_x', type: f32T, attr: '@location(5)' },
    { name: 'abs_merc_y', type: f32T, attr: '@location(6)' },
    { name: 'world_z', type: f32T, attr: '@location(7)' },
    { name: 'v_color', type: vec4fT, attr: '@location(8)' },
  ],
}

const OitFragmentOutput: StructDecl = {
  name: 'OitFragmentOutput',
  fields: [
    { name: 'accum', type: vec4fT, attr: '@location(0)' },
    { name: 'revealage', type: f32T, attr: '@location(1)' },
  ],
}

/** FragmentOutput's `pick` field is conditional on the polygon pipeline carrying
 *  a pick attachment — same plumbing as line.ts's lineFragmentOutput. */
const polygonFragmentOutput = (pickEnabled: boolean): StructDecl => {
  const fields: StructField[] = [{ name: 'color', type: vec4fT, attr: '@location(0)' }]
  if (pickEnabled) fields.push({ name: 'pick', type: vec2uT, attr: '@location(1) @interpolate(flat)' })
  fields.push({ name: 'depth', type: f32T, attr: '@builtin(frag_depth)' })
  return { name: 'FragmentOutput', fields }
}

// ── Binding refs ──
//
// Polygon fixed bindings (matching renderer-shaders.ts 124-132):
//   @group(0) @binding(0) var<uniform> u: Uniforms;
//   @group(0) @binding(5) var sprite_atlas: texture_2d<f32>;
//   @group(0) @binding(6) var sprite_samp: sampler;
// Variant bindings (palette atlas at binding 1-4, scalar atlas at binding 2-3,
// compute output buffers via @group(2), feat_data via @group(1) @binding(0))
// land via the variant's `preamble.bindings` array.

const u = bindingRef('u', structT('Uniforms'))
// sprite_atlas + sprite_samp Node refs land alongside fs_fill_pattern in
// a later iter; their BindingDecl entries appear in buildPolygonModule now
// so the emitted WGSL declarations exactly match renderer-shaders.ts.

// ── Helper fns ──
//
// Per-fragment recompute of the hemisphere-cull signal. The vertex shader
// emits cos_c as a varying but linear interpolation across a triangle
// spanning the visibility boundary diverges — recompute from the absolute-
// Mercator varyings (which telescope exactly under linear interpolation)
// and call the shared needs_backface_cull entry that the vertex path uses.
//
// Cost: 1 atan + 1 exp + a few muls per fragment in the cull path.
// Flat projections (proj_params.x < 2.5) short-circuit inside
// needs_backface_cull to +1 so the per-pixel cost stays at ~0 for the
// common Mercator / equirect / natural-earth cases.
//
// Pattern mirrors line-renderer.ts:779 and point-renderer.ts:340.

const polygonCosCFragment = fn(
  'polygon_cos_c_fragment',
  { abs_merc_x: f32T, abs_merc_y: f32T },
  f32T,
  (b, p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = b.let('abs_lon', p.abs_merc_x.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, p.abs_merc_y))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    b.ret(callFn('needs_backface_cull', f32T, absLon, absLat, u.field('proj_params', vec4fT)))
  },
)

// Companion to polygon_cos_c_fragment: continuous-alpha rim fade across the
// sphere visibility boundary. Fragment shaders multiply this into output
// alpha so geometry on the sphere rim fades smoothly instead of popping at
// the cos_c=0 boundary. Returns 1.0 on flat / cylindrical projections.

const polygonRimAlpha = fn(
  'polygon_rim_alpha',
  { abs_merc_x: f32T, abs_merc_y: f32T },
  f32T,
  (b, p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = b.let('abs_lon', p.abs_merc_x.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, p.abs_merc_y))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    b.ret(callFn('rim_alpha', f32T, absLon, absLat, u.field('proj_params', vec4fT)))
  },
)

// ── Vertex entries ──
//
// vs_main — the f32-precision (DSFUN-split) polygon vertex entry. Reads two
// vec2<f32> attributes (pos_h + pos_l = high/low halves of the tile-local
// Mercator position) + a per-vertex feature_id. Path-by-path:
//   1. DSFUN Mercator subtraction → camera-relative tile-local meters
//      (cancels the large tile-origin magnitude before the low halves are
//      added, preserving f64-equivalent precision at any camera zoom).
//   2. Reconstruct absolute Mercator meters → abs_lon / abs_lat for the
//      fragment shader's hemisphere-cull recompute.
//   3. Mercator → projection-specific xy via project_geom (or rel for the
//      Mercator short-circuit). Globe path uses proj_globe RTC against the
//      orbit-camera MVP.
//   4. MVP transform → log-depth rewrite → fill-translate viewport offset
//      → per-layer NDC-z bias.
//   5. Forward varyings to the fragment shader.

const vsMain = entryFn(
  'vs_main', 'vertex',
  [
    { name: 'pos_h', type: vec2fT, location: 0 },
    { name: 'pos_l', type: vec2fT, location: 1 },
    { name: 'feature_id', type: f32T, location: 2 },
  ],
  structT('VertexOutput'),
  (b, p) => {
    const camH = u.field('cam_h', vec2fT)
    const camL = u.field('cam_l', vec2fT)
    const tileOrigin = u.field('tile_origin_merc', vec2fT)
    const tileExtent = u.field('tile_extent_m', f32T)
    const projParams = u.field('proj_params', vec4fT)
    const mvp = u.field('mvp', mat4x4fT)
    const logDepthFc = u.field('log_depth_fc', f32T)
    const layerDepthOff = u.field('layer_depth_offset', f32T)
    const fillTx = u.field('fill_translate_x', f32T)
    const fillTy = u.field('fill_translate_y', f32T)
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // DSFUN Mercator subtraction — camera-relative tile-local meters.
    const rel = b.let('rel', p.pos_h.sub(camH).add(p.pos_l.sub(camL)))
    // Reconstruct absolute Mercator meters for non-Mercator reprojection
    // + fragment-shader hemisphere cull recompute.
    const absMercX = b.let('abs_merc_x', p.pos_h.x.add(p.pos_l.x).add(tileOrigin.x))
    const absMercY = b.let('abs_merc_y', p.pos_h.y.add(p.pos_l.y).add(tileOrigin.y))
    const absLon = b.let('abs_lon', absMercX.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMercY))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    const absLatClamped = b.let('abs_lat_clamped', clamp(absLat, mercLatLim.neg(), mercLatLim))

    const t = b.let('t', projParams.x)
    const rtc = b.var('rtc', vec2fT)
    b.if(t.lt(0.5), (c) => {
      // Pure Mercator: rel is already camera-relative meters.
      c.assign(rtc, rel)
    }).else((c) => {
      // All other projections: run project_geom on the reconstructed
      // absolute lon/lat, then subtract the projected camera center. f32
      // reconstruction precision is fine at low/global zoom — the only
      // place these projections are exposed.
      const tileRefLon = c.let('tile_ref_lon',
        tileOrigin.x.add(f32(0.5).mul(tileExtent)).div(deg2rad.mul(earthR)),
      )
      const projXy = c.let('proj_xy', callFn('project_geom', vec2fT, absLon, absLat, projParams, tileRefLon))
      const centerXy = c.let('center_xy', callFn('project', vec2fT, projParams.y, projParams.z, projParams))
      c.assign(rtc, projXy.sub(centerXy))
    })

    // True 3D globe (projType 7): RTC against the focus point ON THE
    // sphere, then the orbit-camera MVP.
    const globeRtc = b.let('globe_rtc',
      callFn('proj_globe', vec3fT, absLon, absLat).sub(callFn('proj_globe', vec3fT, projParams.y, projParams.z)),
    )

    const out = b.var('out', structT('VertexOutput'))
    const clip = b.var('clip', vec4fT, select(
      t.gt(6.5),
      transformMat4(mvp, vec4(globeRtc, f32(1))),
      transformMat4(mvp, vec4(rtc, f32(0), f32(1))),
    ))
    // Mapbox fill-translate viewport-anchor — runtime pre-bakes
    // (px*2/canvasDim) so the shader just multiplies by clip.w.
    b.assign(clip.x, clip.x.add(fillTx.mul(clip.w)))
    b.assign(clip.y, clip.y.sub(fillTy.mul(clip.w)))
    // Log-depth rewrite + per-layer NDC-z bias.
    b.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, clip, logDepthFc))
    b.assign(out.field('position', vec4fT).z, out.field('position', vec4fT).z.sub(layerDepthOff.mul(out.field('position', vec4fT).w)))
    b.assign(out.field('view_w', f32T), clip.w)
    // cos_c placeholder — fragments recompute per-pixel.
    b.assign(out.field('cos_c', f32T), f32(0))
    b.assign(out.field('feat_id', u32T), toU32(p.feature_id))
    b.assign(out.field('abs_lat', f32T), absLatClamped)
    // DSFUN line/fill path is not extruded; full brightness.
    b.assign(out.field('wall_blend', f32T), f32(1))
    b.assign(out.field('abs_merc_x', f32T), absMercX)
    b.assign(out.field('abs_merc_y', f32T), absMercY)
    b.assign(out.field('world_z', f32T), f32(0))
    // iter-194 — only the extrude path emits.
    b.assign(out.field('v_color', vec4fT), vec4(f32(0), f32(0), f32(0), f32(0)))
    b.ret(out)
  },
)

// ── Fragment entries ──
//
// fs_overdraw — debug=overdraw single constant-output entry shared by every
// debug-variant pipeline. Vertex shaders still project correctly so the
// rasterizer produces the SAME fragments as the normal path; FS work
// collapses to one write that an additive blend sums into the r16float
// accumulator. NO @builtin(frag_depth) write — debug overdraw doesn't
// participate in the variant marker substitution.

const fsOverdraw = entryFn(
  'fs_overdraw', 'fragment', [], vec4fT,
  (b) => {
    b.ret(vec4(f32(1), f32(0), f32(0), f32(0)))
  },
  '@location(0)',
)

// ── ShaderVariantInfo ──
//
// Phase 2.5 US-007b — the composer-side variant shape. ShaderVariantInfo is
// a subset of @xgis/compiler's ShaderVariant carrying ONLY what
// emitPolygonWgsl needs (the fields the polygon module composes into its
// base ModuleDecl). renderer-side buildShader() converts the legacy
// ShaderVariant into a ShaderVariantInfo at the call seam (US-008).
//
// All fields nullable. A null variant emits the base polygon shader (the
// default-uniform path); a variant with fillExpr / strokeExpr injects the
// per-feature / per-zoom / per-palette path.

export interface ShaderVariantInfo {
  /** Module-shape fragment merged into the polygon base module. consts +
   *  bindings + funcs are appended; the polygon base's structs + entry
   *  fns are never touched by preamble. */
  readonly preamble: Partial<Pick<ModuleDecl, 'consts' | 'bindings' | 'funcs'>> | null
  /** Fill-color expression replacing the placeholder Stmt 'fill-return' in
   *  fs_fill. Null → keep the base default-uniform `u.fill_color` path. */
  readonly fillExpr: Node<'vec4<f32>'> | null
  /** Stroke-color expression replacing the placeholder Stmt 'stroke-return'
   *  in fs_stroke. Null → keep the base `u.stroke_color` path. */
  readonly strokeExpr: Node<'vec4<f32>'> | null
  /** Stmt list emitted BEFORE the fill-return placeholder is replaced (e.g.
   *  `var _mcSS = ...; if (...) { _mcSS = ...; }`). Null → no preamble. */
  readonly fillPreamble: readonly Stmt[] | null
  /** Stmt list emitted BEFORE the stroke-return placeholder. Null → none. */
  readonly strokePreamble: readonly Stmt[] | null
  /** When true, the composer appends a storage binding for feat_data at
   *  @group(1) @binding(0). Per-feature data driven variants set this. */
  readonly needsFeatureBuffer: boolean
  /** P4-5 compute-routed variant bindings. When present, the composer
   *  appends each entry as a storage binding feeding fillExpr / strokeExpr
   *  via `compute_out_<N>[fid]` reads. */
  readonly computeBindings?: readonly {
    readonly bindGroup: number
    readonly binding: number
    readonly bufferName: string
    readonly paintAxis: 'fill' | 'stroke'
  }[]
}

// ── Module assembly ──
//
// PARTIAL — the initial US-007b skeleton lands structs + fixed bindings +
// helper fns + the trivial fs_overdraw entry. Subsequent commits add the
// 3 vertex entries (vs_main / vs_main_quantized / vs_main_quantized_extruded)
// and the 5 main fragment entries (fs_fill with placeholder Stmt at fill-
// return; fs_fill_pattern; fs_oit_translucent; fs_fill_extrude; fs_stroke
// with placeholder Stmt at stroke-return).
//
// The composer's preamble.{consts,bindings,funcs} merge logic + placeholder
// Stmt swap + pick attachment conditional lands in the iter alongside
// the polygon-dsl.test.ts (US-007c) 14 AC3 combination tests.

const buildPolygonModule = (
  variant: ShaderVariantInfo | null,
  pickEnabled: boolean,
): ModuleDecl => {
  const base = module({
    structs: [Uniforms, VertexOutput, OitFragmentOutput, polygonFragmentOutput(pickEnabled)],
    bindings: [
      { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
      { group: 0, binding: 5, name: 'sprite_atlas', space: 'uniform', type: texture2dfT },
      { group: 0, binding: 6, name: 'sprite_samp', space: 'uniform', type: samplerT },
    ],
    funcs: [
      polygonCosCFragment,
      polygonRimAlpha,
      vsMain,
      fsOverdraw,
      // The remaining 2 vertex (vs_main_quantized / vs_main_quantized_extruded)
      // + 5 main fragment entries (fs_fill / fs_fill_pattern /
      // fs_oit_translucent / fs_fill_extrude / fs_stroke) land in subsequent
      // iters.
    ],
  })
  if (variant === null) return base
  return module({
    consts: [...base.consts, ...(variant.preamble?.consts ?? [])],
    structs: base.structs,
    bindings: [...base.bindings, ...(variant.preamble?.bindings ?? [])],
    funcs: [...base.funcs, ...(variant.preamble?.funcs ?? [])],
  })
}

/** Polygon shader emit entry point.
 *
 *  Phase 2.5 US-007b SKELETON — emits the prepended projection consts +
 *  log-depth fns + projection fns, then the polygon base module (structs +
 *  fixed bindings + helpers + fs_overdraw). The 3 vertex + 5 main fragment
 *  entries + the placeholder Stmt swap + the pick attachment conditional
 *  land in subsequent iters.
 *
 *  `pickEnabled` toggles the pick attachment field + writes in the
 *  fragment output struct (replaces the old __PICK_FIELD__ / __PICK_WRITE__
 *  regex markers in POLYGON_SHADER_SOURCE).
 *
 *  `variant` is null for the base polygon shader (default-uniform fill /
 *  stroke); a populated ShaderVariantInfo composes per-feature / per-zoom /
 *  per-palette expressions into the fill / stroke entries via placeholder
 *  Stmt swap.
 */
export const emitPolygonWgsl = (
  variant: ShaderVariantInfo | null,
  pickEnabled: boolean,
): string => [
  PROJECTION_WGSL_CONSTS,
  LOG_DEPTH_WGSL_FNS,
  PROJECTION_WGSL_FNS,
  emitModule(buildPolygonModule(variant, pickEnabled)),
].join('\n')

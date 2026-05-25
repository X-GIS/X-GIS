// ═══ Shader DSL — projection graph (authored once, two backends) ═══
//
// Re-authors runtime/src/engine/shaders/projection.ts (WGSL_PROJECTION_FNS +
// WGSL_PROJECTION_CONSTS) and the (now-deleted) projection-wgsl-mirror.ts as
// ONE IR. The CPU backend regenerates the f64 mirror — so the CPU side of the
// drift class is closed NOW (cpu-projections.ts is generated, not hand-kept).
//
// SCOPE (Phase 0): the WGSL backend's output of this graph is validated, but
// the GPU still runs the hand-written WGSL_PROJECTION_FNS string — wiring
// createShaderModule to emitModule(PROJECTION_MODULE) is Phase 2. Until then
// the hand WGSL ⟷ this IR are kept in lockstep by projection-threshold-drift
// .test.ts + _shader-math-parity.spec.ts; full "single source" lands when the
// GPU is re-targeted onto this graph too.
//
// The int-dispatch ladder (project / project_geom forward selection) is
// GENERATED from PROJECTIONS (projections-table.ts): array index == projType
// == proj_params.x. Adding a projection to the table extends both backends'
// ladders automatically. Cull thresholds are read from the same table so
// they cannot drift from the dispatch.
//
// Constants carry per-backend values: PI/DEG2RAD are the truncated shader
// literals on the WGSL side and full-precision Math.PI / Math.PI/180 on the
// CPU side — reproducing the mirror's f64 numbers (AC2-spike (a)) while the
// emitted WGSL stays byte-faithful to the current shader's constants.

import {
  fn, module, f32, vec2, vec3,
  f32T, vec2fT, vec3fT, vec4fT,
  constRef, callFn, clamp, log, tan, sin, cos, asin, acos, atan, atan2, exp, floor, ceil, smoothstep,
  type ConstDecl, type FuncDecl, type ModuleDecl, type Node, type Builder,
} from './ir'
import { PROJECTIONS } from '../projection/projections-table'

// ── Constants (WGSL value | CPU value) ──
export const PROJECTION_CONSTS: ConstDecl[] = [
  { name: 'PI', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI },
  { name: 'DEG2RAD', type: f32T, wgslValue: 0.01745329, cpuValue: Math.PI / 180 },
  { name: 'EARTH_R', type: f32T, wgslValue: 6378137, cpuValue: 6378137 },
  { name: 'MERCATOR_LAT_LIMIT', type: f32T, wgslValue: 85.051129, cpuValue: 85.051129 },
]

const PI = constRef('PI')
const DEG2RAD = constRef('DEG2RAD')
const EARTH_R = constRef('EARTH_R')
const MERCATOR_LAT_LIMIT = constRef('MERCATOR_LAT_LIMIT')

// Thresholds pulled from the table so dispatch + cull can never drift.
const byName = (n: string) => {
  const r = PROJECTIONS.find((p) => p.name === n)
  if (!r) throw new Error(`projections-dsl: missing table entry ${n}`)
  return r
}
const AZI_CULL = byName('azimuthal_equidistant').cullThreshold as number // -0.85
const STEREO_CULL = byName('stereographic').cullThreshold as number // -0.8
const RIM_FADE = 0.02

// ── Leaf projections ──

const proj_mercator = fn('proj_mercator', { lon_deg: f32T, lat_deg: f32T }, vec2fT, (b, { lon_deg, lat_deg }) => {
  const lat = b.let('lat', clamp(lat_deg, MERCATOR_LAT_LIMIT.neg(), MERCATOR_LAT_LIMIT))
  const x = b.let('x', lon_deg.mul(DEG2RAD).mul(EARTH_R))
  const y = b.let('y', log(tan(PI.div(4).add(lat.mul(DEG2RAD).div(2)))).mul(EARTH_R))
  b.ret(vec2(x, y))
})

const wrap_lon_delta = fn('wrap_lon_delta', { d: f32T }, f32T, (b, { d }) => {
  b.if(d.gt(180), (bb) => { bb.ret(d.sub(ceil(d.sub(180).div(360)).mul(360))) })
  b.if(d.lt(-180), (bb) => { bb.ret(d.add(ceil(d.neg().sub(180).div(360)).mul(360))) })
  b.ret(d)
})

// proj_equirectangular_d / proj_natural_earth_d operate on an already-resolved
// recentred longitude delta.
const proj_equirectangular_d = fn('proj_equirectangular_d', { lon_rel: f32T, lat_deg: f32T }, vec2fT, (b, { lon_rel, lat_deg }) => {
  b.ret(vec2(lon_rel.mul(DEG2RAD).mul(EARTH_R), lat_deg.mul(DEG2RAD).mul(EARTH_R)))
})

const proj_natural_earth_d = fn('proj_natural_earth_d', { lon_rel: f32T, lat_deg: f32T }, vec2fT, (b, { lon_rel, lat_deg }) => {
  const lat = b.let('lat', lat_deg.mul(DEG2RAD))
  const lat2 = b.let('lat2', lat.mul(lat))
  const lat4 = b.let('lat4', lat2.mul(lat2))
  const lat6 = b.let('lat6', lat2.mul(lat4))
  const x_scale = b.let('x_scale',
    f32(0.8707).sub(lat2.mul(0.131979)).add(lat4.mul(0.013791)).sub(lat6.mul(0.0081435)))
  const y_val = b.let('y_val',
    lat.mul(f32(1.007226).add(lat2.mul(
      f32(0.015085).add(lat2.mul(
        f32(-0.044475).add(lat2.mul(0.028874)).sub(lat4.mul(0.005916))))))))
  b.ret(vec2(lon_rel.mul(DEG2RAD).mul(x_scale).mul(EARTH_R), y_val.mul(EARTH_R)))
})

const proj_equirectangular = fn('proj_equirectangular', { lon_deg: f32T, lat_deg: f32T, clon: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon }) => {
  b.ret(callFn('proj_equirectangular_d', vec2fT, callFn('wrap_lon_delta', f32T, lon_deg.sub(clon)), lat_deg))
})

const proj_natural_earth = fn('proj_natural_earth', { lon_deg: f32T, lat_deg: f32T, clon: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon }) => {
  b.ret(callFn('proj_natural_earth_d', vec2fT, callFn('wrap_lon_delta', f32T, lon_deg.sub(clon)), lat_deg))
})

const unwrap_lon_near = fn('unwrap_lon_near', { value: f32T, ref_v: f32T }, f32T, (b, { value, ref_v }) => {
  b.ret(value.sub(floor(value.sub(ref_v).add(180).div(360)).mul(360)))
})

const unwrap_rad_near = fn('unwrap_rad_near', { value: f32T, ref_v: f32T }, f32T, (b, { value, ref_v }) => {
  const two_pi = b.let('two_pi', PI.mul(2))
  b.ret(value.sub(floor(value.sub(ref_v).add(PI).div(two_pi)).mul(two_pi)))
})

const proj_orthographic = fn('proj_orthographic', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon, clat }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const l0 = b.let('l0', clon.mul(DEG2RAD))
  const p0 = b.let('p0', clat.mul(DEG2RAD))
  const x = b.let('x', EARTH_R.mul(cos(phi)).mul(sin(lam.sub(l0))))
  const y = b.let('y', EARTH_R.mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))))
  b.ret(vec2(x, y))
})

const proj_azimuthal_equidistant = fn('proj_azimuthal_equidistant', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon, clat }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const l0 = b.let('l0', clon.mul(DEG2RAD))
  const p0 = b.let('p0', clat.mul(DEG2RAD))
  const cos_c = b.let('cos_c', sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
  const c = b.let('c', acos(clamp(cos_c, f32(-1), f32(1))))
  b.if(c.lt(0.0001), (bb) => { bb.ret(vec2(f32(0), f32(0))) })
  const k = b.let('k', c.div(sin(c)))
  const x = b.let('x', EARTH_R.mul(k).mul(cos(phi)).mul(sin(lam.sub(l0))))
  const y = b.let('y', EARTH_R.mul(k).mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))))
  b.ret(vec2(x, y))
})

const proj_stereographic = fn('proj_stereographic', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon, clat }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const l0 = b.let('l0', clon.mul(DEG2RAD))
  const p0 = b.let('p0', clat.mul(DEG2RAD))
  const cos_c = b.let('cos_c', sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
  b.if(cos_c.lt(-0.9), (bb) => { bb.ret(vec2(f32(1e15), f32(1e15))) })
  const k = b.let('k', f32(2).div(f32(1).add(cos_c)))
  const x = b.let('x', EARTH_R.mul(k).mul(cos(phi)).mul(sin(lam.sub(l0))))
  const y = b.let('y', EARTH_R.mul(k).mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))))
  b.ret(vec2(x, y))
})

const oblique_rot = fn('oblique_rot', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon, clat }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const l0 = b.let('l0', clon.mul(DEG2RAD))
  const p0 = b.let('p0', clat.mul(DEG2RAD))
  const d_lam = b.let('d_lam', lam.sub(l0))
  const phi_rot = b.let('phi_rot', asin(clamp(
    sin(phi).mul(cos(p0)).sub(cos(phi).mul(sin(p0)).mul(cos(d_lam))),
    f32(-1), f32(1))))
  const lam_rot = b.let('lam_rot', atan2(
    cos(phi).mul(sin(d_lam)),
    sin(phi).mul(sin(p0)).add(cos(phi).mul(cos(p0)).mul(cos(d_lam)))))
  b.ret(vec2(lam_rot, phi_rot))
})

const proj_oblique_mercator_d = fn('proj_oblique_mercator_d', { lam_rot: f32T, phi_rot: f32T }, vec2fT, (b, { lam_rot, phi_rot }) => {
  const phi_clamped = b.let('phi_clamped', clamp(phi_rot, MERCATOR_LAT_LIMIT.mul(DEG2RAD).neg(), MERCATOR_LAT_LIMIT.mul(DEG2RAD)))
  const x = b.let('x', EARTH_R.mul(lam_rot))
  const y = b.let('y', EARTH_R.mul(log(tan(PI.div(4).add(phi_clamped.div(2))))))
  b.ret(vec2(x, y))
})

const proj_oblique_mercator = fn('proj_oblique_mercator', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, vec2fT, (b, { lon_deg, lat_deg, clon, clat }) => {
  const r = b.let('r', callFn('oblique_rot', vec2fT, lon_deg, lat_deg, clon, clat))
  b.ret(callFn('proj_oblique_mercator_d', vec2fT, r.x, r.y))
})

const proj_globe = fn('proj_globe', { lon_deg: f32T, lat_deg: f32T }, vec3fT, (b, { lon_deg, lat_deg }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const cphi = b.let('cphi', cos(phi))
  b.ret(vec3(
    EARTH_R.mul(cphi).mul(cos(lam)),
    EARTH_R.mul(cphi).mul(sin(lam)),
    EARTH_R.mul(sin(phi)),
  ))
})

const center_cos_c = fn('center_cos_c', { lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, f32T, (b, { lon_deg, lat_deg, clon, clat }) => {
  const lam = b.let('lam', lon_deg.mul(DEG2RAD))
  const phi = b.let('phi', lat_deg.mul(DEG2RAD))
  const l0 = b.let('l0', clon.mul(DEG2RAD))
  const p0 = b.let('p0', clat.mul(DEG2RAD))
  b.ret(sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
})

// ── Forward dispatch (GENERATED from PROJECTIONS) ──

// Build the forward call for a given table record (per-projection arity).
function forwardCall(name: string, lon: Node, lat: Node, clon: Node, clat: Node): Node {
  switch (name) {
    case 'mercator': return callFn('proj_mercator', vec2fT, lon, lat)
    case 'equirectangular': return callFn('proj_equirectangular', vec2fT, lon, lat, clon)
    case 'natural_earth': return callFn('proj_natural_earth', vec2fT, lon, lat, clon)
    case 'orthographic': return callFn('proj_orthographic', vec2fT, lon, lat, clon, clat)
    case 'azimuthal_equidistant': return callFn('proj_azimuthal_equidistant', vec2fT, lon, lat, clon, clat)
    case 'stereographic': return callFn('proj_stereographic', vec2fT, lon, lat, clon, clat)
    case 'oblique_mercator': return callFn('proj_oblique_mercator', vec2fT, lon, lat, clon, clat)
    default: throw new Error(`projections-dsl: no forward for ${name}`)
  }
}

// 2D-dispatch projections, table-ordered (projType 0..6, globe excluded).
const FLAT = PROJECTIONS.filter((p) => !p.isGlobe)

// Generate the `if (t < n.5) … else …` ladder returning each projection's
// forward — straight from the table order.
function emitForwardLadder(b: Builder, t: Node, lon: Node, lat: Node, clon: Node, clat: Node): void {
  const last = FLAT.length - 1
  const chain = b.if(t.lt(FLAT[0].projType + 0.5), (bb) => { bb.ret(forwardCall(FLAT[0].name, lon, lat, clon, clat)) })
  for (let i = 1; i < last; i++) {
    chain.elif(t.lt(FLAT[i].projType + 0.5), (bb) => { bb.ret(forwardCall(FLAT[i].name, lon, lat, clon, clat)) })
  }
  chain.else((bb) => { bb.ret(forwardCall(FLAT[last].name, lon, lat, clon, clat)) })
}

const project = fn('project', { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT }, vec2fT, (b, { lon_deg, lat_deg, proj_params }) => {
  const t = b.let('t', proj_params.x)
  const clon = b.let('clon', proj_params.y)
  const clat = b.let('clat', proj_params.z)
  emitForwardLadder(b, t, lon_deg, lat_deg, clon, clat)
})

const project_geom = fn('project_geom', { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT, ref_lon: f32T }, vec2fT, (b, { lon_deg, lat_deg, proj_params, ref_lon }) => {
  const t = b.let('t', proj_params.x)
  const clon = b.let('clon', proj_params.y)
  const clat = b.let('clat', proj_params.z)
  // equirect (1) / natural_earth (2): pseudocylindrical world-copy unwrap.
  b.if(t.gt(0.5).and(t.lt(2.5)), (bb) => {
    const wo = bb.let('wo', floor(ref_lon.sub(clon).add(180).div(360)))
    const lon_primary = bb.let('lon_primary', lon_deg.sub(wo.mul(360)))
    const ref_primary = bb.let('ref_primary', ref_lon.sub(wo.mul(360)))
    const ref_d = bb.let('ref_d', callFn('wrap_lon_delta', f32T, ref_primary.sub(clon)))
    const d = bb.let('d', callFn('unwrap_lon_near', f32T, lon_primary.sub(clon), ref_d))
    const world_off_m = bb.let('world_off_m', wo.mul(2).mul(PI).mul(EARTH_R))
    const p = bb.var('p', vec2fT)
    bb.if(t.lt(1.5), (c) => { c.assign(p, callFn('proj_equirectangular_d', vec2fT, d, lat_deg)) })
      .else((c) => { c.assign(p, callFn('proj_natural_earth_d', vec2fT, d, lat_deg)) })
    bb.assign(p.x, p.x.add(world_off_m))
    bb.ret(p)
  })
  // oblique_mercator (6): rotated-frame world-copy unwrap.
  b.if(t.gt(5.5), (bb) => {
    const wo = bb.let('wo', floor(ref_lon.sub(clon).add(180).div(360)))
    const lon_primary = bb.let('lon_primary', lon_deg.sub(wo.mul(360)))
    const ref_primary = bb.let('ref_primary', ref_lon.sub(wo.mul(360)))
    const r = bb.let('r', callFn('oblique_rot', vec2fT, lon_primary, lat_deg, clon, clat))
    const ref_r = bb.let('ref_r', callFn('oblique_rot', vec2fT, ref_primary, clat, clon, clat))
    const lam_u = bb.let('lam_u', callFn('unwrap_rad_near', f32T, r.x, ref_r.x))
    const p = bb.var('p', vec2fT, callFn('proj_oblique_mercator_d', vec2fT, lam_u, r.y))
    bb.assign(p.x, p.x.add(wo.mul(2).mul(PI).mul(EARTH_R)))
    bb.ret(p)
  })
  b.ret(callFn('project', vec2fT, lon_deg, lat_deg, proj_params))
})

// CPU-side project_geom — mirrors the (now-deleted) projection-wgsl-mirror.ts
// projectGeomWgsl, which INTENTIONALLY OMITS the world-copy offset the GPU
// project_geom applies. The CPU consumer (raster tile_rtc) telescopes
// `project_geom(v) − project_geom(SW) + tile_rtc`, so the constant per-tile
// world offset cancels — and label anchors need the absolute camera-relative
// position (no whole-world jump) when the camera sits near ±180°. The GPU
// per-vertex path keeps the offset to place adjacent world copies. These are
// genuinely different functions, so they are authored separately.
const project_geom_cpu = fn('project_geom_cpu', { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT, ref_lon: f32T }, vec2fT, (b, { lon_deg, lat_deg, proj_params, ref_lon }) => {
  const t = b.let('t', proj_params.x)
  const clon = b.let('clon', proj_params.y)
  const clat = b.let('clat', proj_params.z)
  b.if(t.gt(0.5).and(t.lt(2.5)), (bb) => {
    const ref_d = bb.let('ref_d', callFn('wrap_lon_delta', f32T, ref_lon.sub(clon)))
    const d = bb.let('d', callFn('unwrap_lon_near', f32T, lon_deg.sub(clon), ref_d))
    bb.if(t.lt(1.5), (c) => { c.ret(callFn('proj_equirectangular_d', vec2fT, d, lat_deg)) })
      .else((c) => { c.ret(callFn('proj_natural_earth_d', vec2fT, d, lat_deg)) })
  })
  b.if(t.gt(5.5), (bb) => {
    const r = bb.let('r', callFn('oblique_rot', vec2fT, lon_deg, lat_deg, clon, clat))
    const ref_r = bb.let('ref_r', callFn('oblique_rot', vec2fT, ref_lon, clat, clon, clat))
    const lam_u = bb.let('lam_u', callFn('unwrap_rad_near', f32T, r.x, ref_r.x))
    bb.ret(callFn('proj_oblique_mercator_d', vec2fT, lam_u, r.y))
  })
  b.ret(callFn('project', vec2fT, lon_deg, lat_deg, proj_params))
})

const needs_backface_cull = fn('needs_backface_cull', { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT }, f32T, (b, { lon_deg, lat_deg, proj_params }) => {
  const t = b.let('t', proj_params.x)
  const clon = b.let('clon', proj_params.y)
  const clat = b.let('clat', proj_params.z)
  b.if(t.gt(2.5), (bb) => {
    const cc = bb.let('cc', callFn('center_cos_c', f32T, lon_deg, lat_deg, clon, clat))
    bb.if(t.lt(3.5), (c) => { c.ret(cc) }) // ortho — strict hemisphere
    bb.if(t.lt(4.5), (c) => { c.ret(cc.gt(AZI_CULL).select(f32(1), f32(-1))) }) // azimuthal
    bb.if(t.lt(5.5), (c) => { c.ret(cc.gt(STEREO_CULL).select(f32(1), f32(-1))) }) // stereographic
    bb.if(t.lt(6.5), (c) => { c.ret(f32(1)) }) // oblique_mercator — cylindrical
    bb.ret(cc) // globe (7) — strict hemisphere like ortho
  })
  b.ret(f32(1)) // flat projections — no culling
})

const rim_alpha = fn('rim_alpha', { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT }, f32T, (b, { lon_deg, lat_deg, proj_params }) => {
  const t = b.let('t', proj_params.x)
  const clon = b.let('clon', proj_params.y)
  const clat = b.let('clat', proj_params.z)
  const RIM = f32(RIM_FADE)
  b.if(t.gt(2.5), (bb) => {
    const cc = bb.let('cc', callFn('center_cos_c', f32T, lon_deg, lat_deg, clon, clat))
    bb.if(t.lt(3.5), (c) => { c.ret(smoothstep(f32(0), RIM, cc)) }) // ortho
    bb.if(t.lt(4.5), (c) => { c.ret(smoothstep(f32(AZI_CULL), f32(AZI_CULL + RIM_FADE), cc)) }) // azimuthal
    bb.if(t.lt(5.5), (c) => { c.ret(smoothstep(f32(STEREO_CULL), f32(STEREO_CULL + RIM_FADE), cc)) }) // stereographic
    bb.if(t.lt(6.5), (c) => { c.ret(f32(1)) }) // oblique_mercator — no rim
    bb.ret(smoothstep(f32(0), RIM, cc)) // globe (7)
  })
  b.ret(f32(1)) // flat projections — no rim
})

const inv_merc_lat_rad = fn('inv_merc_lat_rad', { merc_y_m: f32T }, f32T, (b, { merc_y_m }) => {
  b.ret(f32(2).mul(atan(exp(merc_y_m.div(EARTH_R)))).sub(PI.div(2)))
})

// ── Module assembly ──

export const PROJECTION_FUNCS: FuncDecl[] = [
  proj_mercator, wrap_lon_delta, proj_equirectangular_d, proj_natural_earth_d,
  proj_equirectangular, proj_natural_earth, unwrap_lon_near, unwrap_rad_near,
  proj_orthographic, proj_azimuthal_equidistant, proj_stereographic,
  oblique_rot, proj_oblique_mercator_d, proj_oblique_mercator, proj_globe,
  center_cos_c, project, project_geom, project_geom_cpu, needs_backface_cull, rim_alpha, inv_merc_lat_rad,
]

export const PROJECTION_MODULE: ModuleDecl = module({
  consts: PROJECTION_CONSTS,
  funcs: PROJECTION_FUNCS,
})

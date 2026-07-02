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
  fn, externFn, module, f32, vec2, vec3,
  ReturnIf, If, Var, Return, f32T, vec2fT, vec4fT,
  radians, clamp, log, tan, sin, cos, asin, acos, atan, atan2, exp, floor, ceil, sign, smoothstep,
  dot, length,
  type ConstDecl, type FuncDecl, type ModuleDecl, type Node, type ReadonlyNode,
} from '@xgis/shader-dsl'
import { emitConst, emitFuncs } from '@xgis/shader-dsl'
import { PI, EARTH_R, MERCATOR_LAT_LIMIT } from './consts'

// ── Backend-agnostic projection injection (standalone-package seam) ──
// shader-dsl owns the projection MATH; the ordered spec list (projType index ==
// array order, globe flag, cull thresholds) is INJECTED by the host so this
// package keeps zero outbound dependency (future standalone repo / extra
// backend). configureProjections() must run before the first emit / cpu-proj
// use (production: the XGISMap constructor; vitest: a setup file; Playwright
// e2e: an explicit call) — an unconfigured access throws loudly.
export interface ProjectionSpec { name: string; projType: number; isGlobe: boolean; cullThreshold?: number | null }
// Host-injected projection config is PROCESS-GLOBAL. Back the state with globalThis so
// it survives module duplication: a bundled-in workspace package (@xgis/map) can be
// instantiated more than once in a mixed resolver (the render-gate node context loads
// map/src via the bundler AND a map/dist copy via a tsconfig-paths/node resolver). A
// per-module `let` would split the singleton — configureProjections() writes one copy's
// specs while a later projection emit reads the other copy's null _specs and throws
// "configureProjections must be called before emit". Sharing across instances makes the
// duplication harmless (configure and emit see the same _specs regardless of instance).
type ProjModuleState = { specs: ProjectionSpec[] | null; artifacts: ReturnType<typeof buildProjectionArtifacts> | null }
const _state: ProjModuleState = ((globalThis as unknown as { __XGIS_PROJECTIONS__?: ProjModuleState }).__XGIS_PROJECTIONS__ ??= { specs: null, artifacts: null })
export function configureProjections(specs: readonly ProjectionSpec[]): void { _state.specs = specs as ProjectionSpec[]; _state.artifacts = null }
function artifacts(): ReturnType<typeof buildProjectionArtifacts> {
  if (_state.specs === null) throw new Error('shader-dsl: configureProjections() must be called before any projection emit / cpu-projection use')
  return (_state.artifacts ??= buildProjectionArtifacts(_state.specs))
}
export const getPROJECTION_MODULE = (): ModuleDecl => artifacts().PROJECTION_MODULE
/** Emitted-WGSL accessor for the parity/structure test harnesses — they splice this exact WGSL into a standalone test shader to verify CPU↔GPU parity. NOT a production path (runtime shaders are built via emitModule, not string-prepend); the emit layer is private, so this string accessor is the sanctioned public surface for those harnesses. */
export const getProjectionWgslConsts = (): string => artifacts().PROJECTION_WGSL_CONSTS
/** Emitted-WGSL accessor for the parity/structure test harnesses — they splice this exact WGSL into a standalone test shader to verify CPU↔GPU parity. NOT a production path (runtime shaders are built via emitModule, not string-prepend); the emit layer is private, so this string accessor is the sanctioned public surface for those harnesses. */
export const getProjectionWgslFns = (): string => artifacts().PROJECTION_WGSL_FNS
/** The GPU projection fn DECLS (project_geom_cpu excluded — CPU-only). Consumers that merge
 *  the projection graph into their own module() (instead of prepending getProjectionWgslFns()
 *  as a string) take these directly; emitModule then emits them in array order, callees before
 *  callers. Injection-deferred like the rest of artifacts() — call post-configureProjections. */
export const getGpuProjectionFuncs = (): FuncDecl[] => artifacts().GPU_PROJECTION_FUNCS

// ── Constants (WGSL value | CPU value) ──
export const PROJECTION_CONSTS: ConstDecl[] = [
  { name: 'PI', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI },
  { name: 'EARTH_R', type: f32T, wgslValue: 6378137, cpuValue: 6378137 },
  { name: 'MERCATOR_LAT_LIMIT', type: f32T, wgslValue: 85.051129, cpuValue: 85.051129 },
  // DEG2RAD survives only as the (DEG2RAD·EARTH_R) divisor in the abs-Mercator → degree paths
  // (line/polygon): folding the EARTH_R factor out to feed degrees() would change this #392-sensitive
  // reverse projection's precision, so it stays the rounded shader literal. Forward deg→rad math uses
  // the exact radians()/degrees() built-ins.
  { name: 'DEG2RAD', type: f32T, wgslValue: 0.01745329, cpuValue: Math.PI / 180 },
]


const RIM_FADE = 0.02

// ── Leaf projections ──

const proj_mercator = fn({ lon_deg: f32T, lat_deg: f32T }, ({ lon_deg, lat_deg }) => {
  const lat = clamp(lat_deg, MERCATOR_LAT_LIMIT.neg(), MERCATOR_LAT_LIMIT)
  const x = radians(lon_deg).mul(EARTH_R)
  const y = log(tan(PI.div(4).add(radians(lat).div(2)))).mul(EARTH_R)
  return vec2(x, y)
})

const wrap_lon_delta = fn({ d: f32T }, ({ d }) => {
  ReturnIf(d.gt(180), d.sub(ceil(d.sub(180).div(360)).mul(360)))
  ReturnIf(d.lt(-180), d.add(ceil(d.neg().sub(180).div(360)).mul(360)))
  return d
})

// proj_equirectangular_d / proj_natural_earth_d operate on an already-resolved
// recentred longitude delta.
const proj_equirectangular_d = fn({ lon_rel: f32T, lat_deg: f32T }, ({ lon_rel, lat_deg }) => {
  return vec2(radians(lon_rel).mul(EARTH_R), radians(lat_deg).mul(EARTH_R))
})

const proj_natural_earth_d = fn({ lon_rel: f32T, lat_deg: f32T }, ({ lon_rel, lat_deg }) => {
  const lat = radians(lat_deg)
  const lat2 = lat.mul(lat)
  const lat4 = lat2.mul(lat2)
  const lat6 = lat2.mul(lat4)
  const x_scale =
    f32(0.8707).sub(lat2.mul(0.131979)).add(lat4.mul(0.013791)).sub(lat6.mul(0.0081435))
  const y_val =
    lat.mul(f32(1.007226).add(lat2.mul(
      f32(0.015085).add(lat2.mul(
        f32(-0.044475).add(lat2.mul(0.028874)).sub(lat4.mul(0.005916)))))))
  return vec2(radians(lon_rel).mul(x_scale).mul(EARTH_R), y_val.mul(EARTH_R))
})

const proj_equirectangular = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T }, ({ lon_deg, lat_deg, clon }) => {
  return proj_equirectangular_d(wrap_lon_delta(lon_deg.sub(clon)), lat_deg)
})

const proj_natural_earth = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T }, ({ lon_deg, lat_deg, clon }) => {
  return proj_natural_earth_d(wrap_lon_delta(lon_deg.sub(clon)), lat_deg)
})

const unwrap_lon_near = fn({ value: f32T, ref_v: f32T }, ({ value, ref_v }) => {
  return value.sub(floor(value.sub(ref_v).add(180).div(360)).mul(360))
})

// Antimeridian seam-keep variant of unwrap_lon_near. Identical to it for every
// input EXCEPT one sitting exactly on the ±180 fold tie, where floor() rounds
// the half-open window [ref−180, ref+180) and pushes a value at +180 across to
// −180 (or vice versa). At the z0 root tile (tile_ref_lon = 0) a clamped MVT
// seam wall lives at exactly abs_lon = ±180 — 180° from the reference, the
// maximal-ambiguity point — so the fold tears the wall a whole world away from
// its in-lobe neighbours: the equirect/NE black-wedge gore at the Russia /
// Chukotka dateline (OFM Bright MVT path). A value/ref-only rule cannot fix it
// because +180 and −180 are mirror images about ref=0; the disambiguator is the
// seam wall's OWN clamped-longitude sign (keep_sign = sign(lon_primary)): a +180
// wall came from an east-overshoot polygon whose body is at +X, a −180 wall from
// a west-overshoot polygon whose body is at −X, so keep each on its own side.
// Biasing the floor boundary by −keep_sign·ε (ε = 1e-4°, far below any real
// vertex spacing) tips the tie toward the wall's lobe. Proven byte-identical to
// unwrap_lon_near for every interior vertex |lon|<180 (the bias never crosses a
// 360° step there) — it fires ONLY at the exact ±180 seam wall.
const SEAM_KEEP_EPS = f32(1e-4)
const unwrap_lon_near_keep = fn({ value: f32T, ref_v: f32T, keep_sign: f32T }, ({ value, ref_v, keep_sign }) => {
  return value.sub(floor(value.sub(ref_v).add(180).sub(keep_sign.mul(SEAM_KEEP_EPS)).div(360)).mul(360))
})

const unwrap_rad_near = fn({ value: f32T, ref_v: f32T }, ({ value, ref_v }) => {
  const two_pi = PI.mul(2)
  return value.sub(floor(value.sub(ref_v).add(PI).div(two_pi)).mul(two_pi))
})

const proj_orthographic = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const l0 = radians(clon)
  const p0 = radians(clat)
  const x = EARTH_R.mul(cos(phi)).mul(sin(lam.sub(l0)))
  const y = EARTH_R.mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
  return vec2(x, y)
})

const proj_azimuthal_equidistant = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const l0 = radians(clon)
  const p0 = radians(clat)
  const cos_c = sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))
  const c = acos(clamp(cos_c, -1, 1))
  ReturnIf(c.lt(0.0001), vec2(0, 0))
  const k = c.div(sin(c))
  const x = EARTH_R.mul(k).mul(cos(phi)).mul(sin(lam.sub(l0)))
  const y = EARTH_R.mul(k).mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
  return vec2(x, y)
})

const proj_stereographic = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const l0 = radians(clon)
  const p0 = radians(clat)
  const cos_c = sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))
  ReturnIf(cos_c.lt(-0.9), vec2(1e15, 1e15))
  const k = f32(2).div(f32(1).add(cos_c))
  const x = EARTH_R.mul(k).mul(cos(phi)).mul(sin(lam.sub(l0)))
  const y = EARTH_R.mul(k).mul(cos(p0).mul(sin(phi)).sub(sin(p0).mul(cos(phi)).mul(cos(lam.sub(l0)))))
  return vec2(x, y)
})

const oblique_rot = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const l0 = radians(clon)
  const p0 = radians(clat)
  const d_lam = lam.sub(l0)
  const phi_rot = asin(clamp(
    sin(phi).mul(cos(p0)).sub(cos(phi).mul(sin(p0)).mul(cos(d_lam))),
    -1, 1))
  const lam_rot = atan2(
    cos(phi).mul(sin(d_lam)),
    sin(phi).mul(sin(p0)).add(cos(phi).mul(cos(p0)).mul(cos(d_lam))))
  return vec2(lam_rot, phi_rot)
})

const proj_oblique_mercator_d = fn({ lam_rot: f32T, phi_rot: f32T }, ({ lam_rot, phi_rot }) => {
  // Singularity-only clamp (NOT the 85.05° Web-Mercator clamp).
  // log(tan(π/4+phi/2)) is finite over |phi|<π/2 and diverges at the
  // pole; the plain Mercator clamp collapses every distinct phi_rot
  // past 85.05° to the same Y — yields degenerate tile-mesh vertices
  // when the camera pans to a real polar region (oblique tile
  // tearing, 2026-05-19). Keep distinct Y for distinct phi_rot up to
  // a hair below the pole. See oblique-polar-tearing.test.ts.
  const POLE_EPS_DEG = f32(90 - 1e-4)
  const phi_clamped = clamp(phi_rot, radians(POLE_EPS_DEG).neg(), radians(POLE_EPS_DEG))
  const x = EARTH_R.mul(lam_rot)
  const y = EARTH_R.mul(log(tan(PI.div(4).add(phi_clamped.div(2)))))
  return vec2(x, y)
})

const proj_oblique_mercator = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const r = oblique_rot(lon_deg, lat_deg, clon, clat)
  return proj_oblique_mercator_d(r.x, r.y)
})

const proj_globe = fn({ lon_deg: f32T, lat_deg: f32T }, ({ lon_deg, lat_deg }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const cphi = cos(phi)
  return vec3(
    EARTH_R.mul(cphi).mul(cos(lam)),
    EARTH_R.mul(cphi).mul(sin(lam)),
    EARTH_R.mul(sin(phi)),
  )
})

const center_cos_c = fn({ lon_deg: f32T, lat_deg: f32T, clon: f32T, clat: f32T }, ({ lon_deg, lat_deg, clon, clat }) => {
  const lam = radians(lon_deg)
  const phi = radians(lat_deg)
  const l0 = radians(clon)
  const p0 = radians(clat)
  return sin(p0).mul(sin(phi)).add(cos(p0).mul(cos(phi)).mul(cos(lam.sub(l0))))
})

// ── Injection-deferred projection call handles (consumer-facing externs) ──
// project / flat_rel / needs_backface_cull / rim_alpha / inv_merc_lat_rad have
// table-DEPENDENT bodies (dispatch ladder + cull thresholds), so their definitions are
// built inside buildProjectionArtifacts and only exist post-configureProjections(). That
// is too late for the polygon / line / point / raster / heatmap shader modules, which
// author their bodies eagerly at import — so those consumers fell back to raw
// callFn('project', …) string calls. These externs give them a TYPED, importable call
// handle now; the real bodies are linked in at emit via getPROJECTION_MODULE() /
// getProjectionWgslFns(). The SIGNATURE (params + ret) is table-INDEPENDENT, so each spec
// const is SHARED with the real fn() below — the extern can never drift from its
// definition — and the emitted node is the same call-by-name as before (byte-identical).
const LLP_PARAMS = { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT }
const LLPR_PARAMS = { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT, ref_lon: f32T }
// #600 — needs_backface_cull / rim_alpha take an extra globe_eye vec4: the
// globe(7) arm switched from the PITCH-INVARIANT center-hemisphere cull
// (great-circle angle from clon/clat) to the EYE-HORIZON cap. The perspective
// globe eye tilts off the centre normal at high pitch + looks across the sphere
// toward the limb, so the visible region is the eye-horizon cap, NOT the centre
// hemisphere — center_cos_c wrongly discarded ~30% of the eye-visible far cap.
// globe_eye = (normalize(eye_ecef).xyz, EARTH_R/|eye_ecef|): the SAME sphere
// horizon model the globe TILE selector (globe.ts) + label projector
// (render-loop-helpers.ts) already use. The DISC arms (ortho/azimuthal/
// stereographic 3/4/5) IGNORE globe_eye — they are flat discs whose visible
// region IS the centre hemisphere (pitch-invariant), so they keep center_cos_c.
const LLPE_PARAMS = { lon_deg: f32T, lat_deg: f32T, proj_params: vec4fT, globe_eye: vec4fT }
const INV_MERC_PARAMS = { merc_y_m: f32T }
// snake_case to MATCH the WGSL fn name (the log-depth / sdf GPU-handle convention) and to
// avoid colliding with cpu-projections' camelCase `invMercLatRad` (the f64 CPU helper). Each
// shadows its real fn() definition inside buildProjectionArtifacts — benign: an extern call
// and the real handle's call both emit the same callFn-by-name node.
export const project = externFn('project', LLP_PARAMS, vec2fT)
export const flat_rel = externFn('flat_rel', LLPR_PARAMS, vec2fT)
export const needs_backface_cull = externFn('needs_backface_cull', LLPE_PARAMS, f32T)
export const rim_alpha = externFn('rim_alpha', LLPE_PARAMS, f32T)
export const inv_merc_lat_rad = externFn('inv_merc_lat_rad', INV_MERC_PARAMS, f32T)

// ── Projection artifacts builder (table-injected via ProjectionSpec seam) ──
// Every table-dependent declaration lives inside this function so the injected
// spec list drives the dispatch ladder + cull thresholds. Built once, memoized
// by artifacts(). Leaf projection fns + PROJECTION_CONSTS above are table-free
// and stay eager (module scope, referenced here via closure).
function buildProjectionArtifacts(specs: ProjectionSpec[]) {
const byName = (n: string) => {
  const r = specs.find((p) => p.name === n)
  if (!r) throw new Error(`projections-dsl: missing spec entry ${n}`)
  return r
}
const AZI_CULL = byName('azimuthal_equidistant').cullThreshold as number // -0.85
const STEREO_CULL = byName('stereographic').cullThreshold as number // -0.8

// ── Forward dispatch (GENERATED from the injected specs) ──

// Build the forward call for a given table record (per-projection arity).
function forwardCall(name: string, lon: ReadonlyNode, lat: ReadonlyNode, clon: ReadonlyNode, clat: ReadonlyNode): Node {
  switch (name) {
    case 'mercator': return proj_mercator(lon, lat)
    case 'equirectangular': return proj_equirectangular(lon, lat, clon)
    case 'natural_earth': return proj_natural_earth(lon, lat, clon)
    case 'orthographic': return proj_orthographic(lon, lat, clon, clat)
    case 'azimuthal_equidistant': return proj_azimuthal_equidistant(lon, lat, clon, clat)
    case 'stereographic': return proj_stereographic(lon, lat, clon, clat)
    case 'oblique_mercator': return proj_oblique_mercator(lon, lat, clon, clat)
    default: throw new Error(`projections-dsl: no forward for ${name}`)
  }
}

// 2D-dispatch projections, table-ordered (projType 0..6, globe excluded).
const FLAT = specs.filter((p) => !p.isGlobe)

// Generate the `if (t < n.5) … else …` ladder returning each projection's
// forward — straight from the table order.
function emitForwardLadder(t: ReadonlyNode, lon: ReadonlyNode, lat: ReadonlyNode, clon: ReadonlyNode, clat: ReadonlyNode): void {
  const last = FLAT.length - 1
  const chain = If(t.lt(FLAT[0].projType + 0.5), () => { Return(forwardCall(FLAT[0].name, lon, lat, clon, clat)) })
  for (let i = 1; i < last; i++) {
    chain.elif(t.lt(FLAT[i].projType + 0.5), () => { Return(forwardCall(FLAT[i].name, lon, lat, clon, clat)) })
  }
  chain.else(() => { Return(forwardCall(FLAT[last].name, lon, lat, clon, clat)) })
}

const project = fn(LLP_PARAMS, vec2fT, ({ lon_deg, lat_deg, proj_params }) => {
  const t = proj_params.x
  const clon = proj_params.y
  const clat = proj_params.z
  emitForwardLadder(t, lon_deg, lat_deg, clon, clat)
})

const project_geom = fn(LLPR_PARAMS, ({ lon_deg, lat_deg, proj_params, ref_lon }) => {
  const t = proj_params.x
  const clon = proj_params.y
  const clat = proj_params.z
  // equirect (1) / natural_earth (2): pseudocylindrical world-copy unwrap.
  If(t.gt(0.5).and(t.lt(2.5)), () => {
    const wo = floor(ref_lon.sub(clon).add(180).div(360))
    const lon_primary = lon_deg.sub(wo.mul(360))
    const ref_primary = ref_lon.sub(wo.mul(360))
    const ref_d = wrap_lon_delta(ref_primary.sub(clon))
    // Ref-relative composition (antimeridian seam-flicker fix): recover the
    // recentred delta d as (lon_primary − ref_primary) unwrapped about the
    // tile reference, then add ref_d (= small wrap_lon_delta(ref_primary−clon)).
    // lon_primary and ref_primary share the SAME wo-window, so
    // |lon_primary − ref_primary| ≤ ~180 — no 360-magnitude f32 intermediate.
    // The old `lon_primary.sub(clon)` formed −359.99 for the cross-copy west
    // antimeridian tile when the camera sat near ±180, and the f32 ULP there
    // (~3.4 m) leaked into the recovered residual: the +180/−180 shared edge
    // disagreed sub-pixel and step-changed with clon → the dateline-drag
    // seam flicker. Equal to the old d everywhere except that fold.
    const lon_rel_ref = unwrap_lon_near_keep(lon_primary.sub(ref_primary), f32(0), sign(lon_primary))
    const d = lon_rel_ref.add(ref_d)
    const world_off_m = wo.mul(2).mul(PI).mul(EARTH_R)
    const p = Var(vec2fT)
    If(t.lt(1.5), () => { p.assign(proj_equirectangular_d(d, lat_deg)) })
      .else(() => {
        // NE-lobe wrap (antimeridian black-wedge fix): proj_natural_earth_d's
        // 6th-order polynomial is valid ONLY for d ∈ [−180,180]; an out-of-lobe
        // d (e.g. −360 when the camera sits on the antimeridian and a world-copy
        // references clon≈0) returns a NONLINEAR wrong-region x that
        // world_off_m cannot cancel → the mesh folds and leaves the
        // camera-facing oval centre uncovered (black). Fold d into one lobe
        // (dw) before the forward and push the 360°-steps (k) into the world
        // offset. Equirect is LINEAR so its out-of-range d is exactly absorbed
        // by world_off_m — it keeps the shared d path (byte-identical WGSL).
        const dw = wrap_lon_delta(d)
        const k = floor(d.sub(dw).div(360).add(0.5))
        p.assign(proj_natural_earth_d(dw, lat_deg))
        p.x.assign(p.x.add(k.mul(2).mul(PI).mul(EARTH_R)))
      })
    p.x.assign(p.x.add(world_off_m))
    Return(p)
  })
  // oblique_mercator (6): rotated-frame world-copy unwrap.
  If(t.gt(5.5), () => {
    const wo = floor(ref_lon.sub(clon).add(180).div(360))
    const lon_primary = lon_deg.sub(wo.mul(360))
    const ref_primary = ref_lon.sub(wo.mul(360))
    const r = oblique_rot(lon_primary, lat_deg, clon, clat)
    const ref_r = oblique_rot(ref_primary, clat, clon, clat)
    const lam_u = unwrap_rad_near(r.x, ref_r.x)
    const p = Var(proj_oblique_mercator_d(lam_u, r.y))
    p.x.assign(p.x.add(wo.mul(2).mul(PI).mul(EARTH_R)))
    Return(p)
  })
  return project(lon_deg, lat_deg, proj_params)
})

// CPU-side project_geom — mirrors the (now-deleted) projection-wgsl-mirror.ts
// projectGeomWgsl, which INTENTIONALLY OMITS the world-copy offset the GPU
// project_geom applies. The CPU consumer (raster tile_rtc) telescopes
// `project_geom(v) − project_geom(SW) + tile_rtc`, so the constant per-tile
// world offset cancels — and label anchors need the absolute camera-relative
// position (no whole-world jump) when the camera sits near ±180°. The GPU
// per-vertex path keeps the offset to place adjacent world copies. These are
// genuinely different functions, so they are authored separately.
const project_geom_cpu = fn(LLPR_PARAMS, ({ lon_deg, lat_deg, proj_params, ref_lon }) => {
  const t = proj_params.x
  const clon = proj_params.y
  const clat = proj_params.z
  If(t.gt(0.5).and(t.lt(2.5)), () => {
    const ref_d = wrap_lon_delta(ref_lon.sub(clon))
    // Ref-relative composition — mirrors the GPU project_geom seam-flicker fix
    // (no world offset here; ref_lon plays ref_primary, lon_deg plays
    // lon_primary). Keeps every intermediate small-magnitude so the f32-class
    // cross-copy cancellation cannot reappear if a consumer rounds to f32.
    const lon_rel_ref = unwrap_lon_near_keep(lon_deg.sub(ref_lon), f32(0), sign(lon_deg))
    const d = lon_rel_ref.add(ref_d)
    If(t.lt(1.5), () => { Return(proj_equirectangular_d(d, lat_deg)) })
      .else(() => {
        // NE-lobe wrap — CPU mirror of the GPU project_geom black-wedge fix.
        // proj_natural_earth_d is a polynomial valid only for d ∈ [−180,180];
        // fold d into one lobe (dw) before the forward, then re-add the
        // 360°-steps (k) as the lobe offset. The k·2πR term is the SAME lobe
        // step the GPU world_off_m carries — it is NOT the omitted world-copy
        // (wo) offset, but the per-vertex correction that keeps a seam-
        // straddling tile contiguous when the raster consumer telescopes
        // project_geom(v) − project_geom(SW). Without it wrap_lon_delta would
        // hard-fold every vertex back to clon±180, erasing project_geom's
        // seam-awareness (a tile crossing ±180 would tear). Label anchors call
        // with ref_lon = the anchor's own lon, so d is in-lobe (k = 0) and the
        // term vanishes — no whole-world jump near ±180. No-op for in-range d;
        // equirect is linear and keeps the shared d path.
        const dw = wrap_lon_delta(d)
        const k = floor(d.sub(dw).div(360).add(0.5))
        const p = Var(proj_natural_earth_d(dw, lat_deg))
        p.x.assign(p.x.add(k.mul(2).mul(PI).mul(EARTH_R)))
        Return(p)
      })
  })
  If(t.gt(5.5), () => {
    const r = oblique_rot(lon_deg, lat_deg, clon, clat)
    const ref_r = oblique_rot(ref_lon, clat, clon, clat)
    const lam_u = unwrap_rad_near(r.x, ref_r.x)
    Return(proj_oblique_mercator_d(lam_u, r.y))
  })
  Return(project(lon_deg, lat_deg, proj_params))
})

// flat_rel — camera-relative projected 2D position for the flat DISPLAY path
// (projection-display-layer-restore). The single source for the flat reproject
// + recentre composition shared by the polygon / line / point / raster flat
// branches: project the vertex (project_geom is world-copy aware for the
// pseudocylindrical / rotated forms and falls through to plain project for the
// azimuthal discs) and subtract the camera centre projected the same way
// (proj_params.y/z = clon/clat). ref_lon selects the world copy — tile-centre
// lon for tiled sources, the vertex's own lon for individual points. Restores
// the per-shader pre-ECEF finalize_corner body as ONE reusable fn.
const flat_rel = fn(LLPR_PARAMS, ({ lon_deg, lat_deg, proj_params, ref_lon }) => {
  const pv = project_geom(lon_deg, lat_deg, proj_params, ref_lon)
  const cv = project(proj_params.y, proj_params.z, proj_params)
  return pv.sub(cv)
})

// globe_eye_horizon_cos — #600 eye-horizon visibility signal for the globe (7)
// arm, in COSINE units (directly comparable to center_cos_c, so it slots into
// the same cull-sign + RIM_FADE smoothstep the centre-hemisphere arm used).
// Reconstruct the surface point P on the SPHERE (proj_globe; |P| = EARTH_R) and
// return dot(normalize(P), eye_dir) − horizonCos, where globe_eye = (eye_dir,
// horizonCos) = (normalize(eye_ecef), EARTH_R/|eye_ecef|). A point faces the eye
// iff dot(normalize(P), normalize(eye)) > EARTH_R/|eye| (the sphere horizon cut),
// so this is > 0 on the visible eye-horizon cap and < 0 on the far cap. SPHERE P
// (not the ellipsoid lonLatToECEF) keeps the test self-consistent with the
// EARTH_R/|eye| threshold and byte-matches the globe.ts tile selector's model.
const globe_eye_horizon_cos = fn({ lon_deg: f32T, lat_deg: f32T, globe_eye: vec4fT }, ({ lon_deg, lat_deg, globe_eye }) => {
  const p = proj_globe(lon_deg, lat_deg)
  const pn = p.div(length(p))
  return dot(pn, globe_eye.swizzle('xyz')).sub(globe_eye.w)
})

const needs_backface_cull = fn(LLPE_PARAMS, ({ lon_deg, lat_deg, proj_params, globe_eye }) => {
  const t = proj_params.x
  const clon = proj_params.y
  const clat = proj_params.z
  If(t.gt(2.5), () => {
    const cc = center_cos_c(lon_deg, lat_deg, clon, clat)
    If(t.lt(3.5), () => { Return(cc) }) // ortho — strict hemisphere (flat disc, pitch-invariant)
    If(t.lt(4.5), () => { Return(cc.gt(AZI_CULL).select(f32(1), f32(-1))) }) // azimuthal
    If(t.lt(5.5), () => { Return(cc.gt(STEREO_CULL).select(f32(1), f32(-1))) }) // stereographic
    If(t.lt(6.5), () => { Return(f32(1)) }) // oblique_mercator — cylindrical
    // globe (7) — #600 EYE-HORIZON cap (NOT the pitch-invariant centre
    // hemisphere): the perspective eye tilts off the centre normal at high
    // pitch, so the visible region is the eye-horizon cap. > 0 = visible.
    // globe_eye.w = EARTH_R/|eye| is ALWAYS > 0 for a real camera, so w == 0 is
    // the reliable sentinel for "globe_eye NOT written" — the non-tiled / GeoJSON
    // layer path (renderer.ts renderToPass) packs uniforms only up to byte 176 and
    // leaves globe_eye zero. Without this guard those layers read globe_eye=0,
    // globe_eye_horizon_cos returns 0, rim_alpha smoothsteps to 0 alpha, and the
    // whole layer renders BLANK on the globe. Fall back to the pre-#600
    // centre-hemisphere cull (cc) when globe_eye is unwritten.
    If(globe_eye.w.gt(0), () => { Return(globe_eye_horizon_cos(lon_deg, lat_deg, globe_eye)) })
    Return(cc)
  })
  return f32(1) // flat projections — no culling
})

const rim_alpha = fn(LLPE_PARAMS, ({ lon_deg, lat_deg, proj_params, globe_eye }) => {
  const t = proj_params.x
  const clon = proj_params.y
  const clat = proj_params.z
  const RIM = f32(RIM_FADE)
  If(t.gt(2.5), () => {
    const cc = center_cos_c(lon_deg, lat_deg, clon, clat)
    If(t.lt(3.5), () => { Return(smoothstep(0, RIM, cc)) }) // ortho
    If(t.lt(4.5), () => { Return(smoothstep(f32(AZI_CULL), f32(AZI_CULL + RIM_FADE), cc)) }) // azimuthal
    If(t.lt(5.5), () => { Return(smoothstep(f32(STEREO_CULL), f32(STEREO_CULL + RIM_FADE), cc)) }) // stereographic
    If(t.lt(6.5), () => { Return(f32(1)) }) // oblique_mercator — no rim
    // globe (7) — #600: fade across the EYE-HORIZON boundary (same signal the
    // cull uses) so the far cap kept by the eye-horizon cull is NOT faded to 0
    // by a centre-hemisphere rim (which would re-hide it via alpha). globe_eye.w
    // == 0 = globe_eye unwritten (non-tiled / GeoJSON path) → fall back to the
    // centre-hemisphere rim so the layer is not faded to 0 alpha (blank globe).
    If(globe_eye.w.gt(0), () => { Return(smoothstep(0, RIM, globe_eye_horizon_cos(lon_deg, lat_deg, globe_eye))) })
    Return(smoothstep(0, RIM, cc))
  })
  return f32(1) // flat projections — no rim
})

const inv_merc_lat_rad = fn(INV_MERC_PARAMS, ({ merc_y_m }) => {
  return f32(2).mul(atan(exp(merc_y_m.div(EARTH_R)))).sub(PI.div(2))
})

// ── Module assembly ──

// #763 H9 — name-once (key-record) assembly, the production exemplar: the fn()
// definitions above are ANONYMOUS; these record keys are their emitted names
// (deterministic rename at module assembly — declRef keeps every handle-made call
// site in step, so fnAutoId never reaches the WGSL). Key order is emit order
// (callees before callers), exactly the old array order.
const PROJECTION_FN_RECORD = {
  proj_mercator, wrap_lon_delta, proj_equirectangular_d, proj_natural_earth_d,
  proj_equirectangular, proj_natural_earth, unwrap_lon_near, unwrap_lon_near_keep, unwrap_rad_near,
  proj_orthographic, proj_azimuthal_equidistant, proj_stereographic,
  oblique_rot, proj_oblique_mercator_d, proj_oblique_mercator, proj_globe,
  center_cos_c, globe_eye_horizon_cos, project, project_geom, project_geom_cpu, flat_rel, needs_backface_cull, rim_alpha, inv_merc_lat_rad,
}
// MISRA single-exit DEVIATION (whole module) — projection is the perf-critical dispatch
// hotspot (project / project_geom select projection-by-type via early return; single-exit
// would compute every projection per vertex) + the highest-bug-density code. Byte-identical.
// Applied in place on the handle AND its decl (not a spread copy — a copy would strand the
// declRef call-site rewrite on the un-renamed originals; the handle's decl-field mirror is
// a snapshot, so the lint reading module.funcs sees the HANDLE's own property).
for (const h of Object.values(PROJECTION_FN_RECORD)) {
  ;(h as unknown as { allowEarlyReturn?: boolean }).allowEarlyReturn = true
  ;(h.decl as { allowEarlyReturn?: boolean }).allowEarlyReturn = true
}

const PROJECTION_MODULE: ModuleDecl = module({
  consts: PROJECTION_CONSTS,
  funcs: PROJECTION_FN_RECORD,
})
const PROJECTION_FUNCS: FuncDecl[] = [...PROJECTION_MODULE.funcs]

// ── GPU shader emission (US-P0-4b: the live GPU block, generated) ──
// The GPU runs every projection fn EXCEPT project_geom_cpu, which is the
// CPU-only no-world-offset variant (the GPU uses project_geom, with offset).
// shaders/projection.ts re-exports these as WGSL_PROJECTION_CONSTS /
// WGSL_PROJECTION_FNS — so the polygon / line / point / raster shaders now
// consume DSL-emitted WGSL from the SAME graph as the cpu-f64 lowering.
const GPU_PROJECTION_FUNCS = PROJECTION_FUNCS.filter((f) => f.name !== 'project_geom_cpu')
const PROJECTION_WGSL_CONSTS = `${PROJECTION_CONSTS.map(emitConst).join('\n')}\n`
const PROJECTION_WGSL_FNS = `${emitFuncs(GPU_PROJECTION_FUNCS)}\n`

  return { PROJECTION_FUNCS, GPU_PROJECTION_FUNCS, PROJECTION_MODULE, PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS }
}

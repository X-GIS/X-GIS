// ═══ Shader DSL — generated CPU projection dispatch ═══
//
// The cpu-f64 lowering of PROJECTION_MODULE, exposed with the SAME signatures
// projection-wgsl-mirror.ts exports. This is the generated replacement for
// the hand-maintained mirror: tile-selection, raster tile_rtc, and label
// anchors call these (numbers unchanged — same f64 op tree, same consts).
//
// The globe (projType 7) throw-guard is reproduced here (it lived in the
// mirror's projectWgsl/projectGeomWgsl, NOT in the GPU dispatch): projType 7
// has no 2D forward, so a stray caller must fail loudly rather than silently
// take the oblique-mercator else-arm.

import { compileModule } from './backend-cpu'
import { PROJECTION_MODULE } from './projections'

const M = compileModule(PROJECTION_MODULE)
const pp = (projType: number, clon: number, clat: number): number[] => [projType, clon, clat, 0]
const vec2 = (v: unknown): [number, number] => v as [number, number]

// ── Per-projection forwards (mirror parity) ──
export const projMercatorCpu = (lon: number, lat: number): [number, number] => vec2(M.fns.proj_mercator(lon, lat))
export const projEquirectangularCpu = (lon: number, lat: number, clon = 0): [number, number] => vec2(M.fns.proj_equirectangular(lon, lat, clon))
export const projEquirectangularDCpu = (lonRel: number, lat: number): [number, number] => vec2(M.fns.proj_equirectangular_d(lonRel, lat))
export const projNaturalEarthCpu = (lon: number, lat: number, clon = 0): [number, number] => vec2(M.fns.proj_natural_earth(lon, lat, clon))
export const projNaturalEarthDCpu = (lonRel: number, lat: number): [number, number] => vec2(M.fns.proj_natural_earth_d(lonRel, lat))
export const projOrthographicCpu = (lon: number, lat: number, clon: number, clat: number): [number, number] => vec2(M.fns.proj_orthographic(lon, lat, clon, clat))
export const projAzimuthalEquidistantCpu = (lon: number, lat: number, clon: number, clat: number): [number, number] => vec2(M.fns.proj_azimuthal_equidistant(lon, lat, clon, clat))
export const projStereographicCpu = (lon: number, lat: number, clon: number, clat: number): [number, number] => vec2(M.fns.proj_stereographic(lon, lat, clon, clat))
export const obliqueRotCpu = (lon: number, lat: number, clon: number, clat: number): [number, number] => vec2(M.fns.oblique_rot(lon, lat, clon, clat))
export const projObliqueMercatorDCpu = (lamRot: number, phiRot: number): [number, number] => vec2(M.fns.proj_oblique_mercator_d(lamRot, phiRot))
export const projObliqueMercatorCpu = (lon: number, lat: number, clon: number, clat: number): [number, number] => vec2(M.fns.proj_oblique_mercator(lon, lat, clon, clat))

export const cosCCpu = (lon: number, lat: number, clon: number, clat: number): number => M.fns.center_cos_c(lon, lat, clon, clat) as number
export const invMercLatRadCpu = (mercYm: number): number => M.fns.inv_merc_lat_rad(mercYm) as number
export const wrapLonDeltaCpu = (d: number): number => M.fns.wrap_lon_delta(d) as number
export const unwrapLonNearCpu = (value: number, ref: number): number => M.fns.unwrap_lon_near(value, ref) as number
export const unwrapRadNearCpu = (value: number, ref: number): number => M.fns.unwrap_rad_near(value, ref) as number

export const projGlobeCpu = (lon: number, lat: number): [number, number, number] =>
  M.fns.proj_globe(lon, lat) as [number, number, number]

// ── Dispatchers (mirror projectWgsl / projectGeomWgsl / needs_backface_cull) ──
export function projectCpu(projType: number, lon: number, lat: number, clon: number, clat: number): [number, number] {
  if (projType > 6.5) throw new Error(`projectCpu: projType ${projType} (globe) has no 2D projection — use globeForward`)
  return vec2(M.fns.project(lon, lat, pp(projType, clon, clat)))
}

export function projectGeomCpu(projType: number, lon: number, lat: number, clon: number, clat: number, refLon: number): [number, number] {
  if (projType > 6.5) throw new Error(`projectGeomCpu: projType ${projType} (globe) has no 2D projection — use globeForward`)
  return vec2(M.fns.project_geom(lon, lat, pp(projType, clon, clat), refLon))
}

export function needsBackfaceCullCpu(projType: number, lon: number, lat: number, clon: number, clat: number): number {
  return M.fns.needs_backface_cull(lon, lat, pp(projType, clon, clat)) as number
}

export function rimAlphaCpu(projType: number, lon: number, lat: number, clon: number, clat: number): number {
  return M.fns.rim_alpha(lon, lat, pp(projType, clon, clat)) as number
}

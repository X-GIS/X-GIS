// ═══ Shader DSL — under-occluder sphere (INC-1, non-merc direct-reprojection) ═══
//
// A solid-colour opaque sphere seated JUST UNDER EARTH_R, drawn depth-writing
// before the globe vector pass. Its job is NOT to be seen (on the direct path
// the polygon eye-horizon cull already closes the fill limb — #600); it is the
// robustness floor the design's INC-1 mandates: a hard, non-faded, opaque
// backing so (a) a residual T-junction / cross-LOD crack in the vector fills
// bleeds to the SPHERE colour instead of the void/far-side, and (b) future
// depth-testing geometry (3D extrusions / points drawn direct once the drape is
// retired) on the FAR hemisphere is depth-blocked at the limb.
//
// GLOBE (projType 7) ONLY. The disc projTypes {3,4,5} reproject from the
// flat_rel DEGREE arm (polygon.ts) and are NOT seated by an ECEF sphere — their
// occluder is separate, deferred work (design INC-6). The caller gates this to
// globe, so mercator/flat/disc emit no draw and stay byte-identical.
//
// The vertices arrive as ABSOLUTE ECEF metres ALREADY scaled to (1−ε)·radius on
// the CPU (under-occluder-renderer.ts), plus per-vertex lon/lat degrees for the
// per-fragment eye-horizon cull. The VS recentres by the camera ECEF anchor
// (RTC, same frame the polygon / raster ECEF paths use) and applies the SAME
// log-depth so the occluder z-registers with the vector fills.

import {
  fn,
  module,
  transformMat4,
  vec3,
  vec4,
  vec2u,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
  vec2uT,
  mat4x4fT,
  If,
  Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import {
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
  needs_backface_cull,
  rim_alpha,
} from './projections'
import { ECEF_CONSTS } from './ecef'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    mvp: mat4x4fT,
    // proj_params: x=type (7), y=centerLon, z=centerLat, w=log_depth_fc — the
    // SAME lane layout needs_backface_cull / rim_alpha / apply_log_depth read.
    proj_params: vec4fT,
    // Camera-relative RTC anchor: the vertex ECEF is absolute, so subtract the
    // camera centre to feed the camera-at-ENU-origin MVP (mirrors raster's
    // cam_ecef_center). xyz = rasterGlobeCamAnchor(centerLon, centerLat); w unused.
    cam_ecef_center: vec4fT,
    // #600 eye-horizon cull cap: xyz = normalize(eye_ecef), w = EARTH_R/|eye|.
    globe_eye: vec4fT,
    // Sphere colour (straight-alpha unit floats) — the resolved background fill.
    color: vec4fT,
  },
)
export { U as underOccluderU }

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  view_w: location(0, f32T),
  abs_lon: location(1, f32T),
  abs_lat: location(2, f32T),
})

const occluderFragmentOutput = (pickEnabled: boolean) =>
  ioStruct('OccluderFragmentOutput', {
    color: location(0, vec4fT),
    ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
    depth: builtin('frag_depth', f32T),
  })

const vs = fn(
  'vs_occluder',
  { pos_ecef: location(0, vec3fT), lonlat: location(1, vec2fT) },
  (p) => {
    const cam = U.field.cam_ecef_center
    const ecefRtc = p.pos_ecef.sub(vec3(cam.x, cam.y, cam.z))
    const clip = transformMat4(U.field.mvp, vec4(ecefRtc.x, ecefRtc.y, ecefRtc.z, 1))
    return VsOut.construct({
      pos: apply_log_depth({ pos: clip, fc: U.field.proj_params.w }),
      view_w: clip.w,
      abs_lon: p.lonlat.x,
      abs_lat: p.lonlat.y,
    })
  },
  { stage: 'vertex' },
)

const buildFs = (pickEnabled: boolean) => {
  const OccluderFragmentOutput = occluderFragmentOutput(pickEnabled)
  return fn(
    'fs_occluder',
    { input: VsOut },
    (p) => {
      const pin = p.input
      // Per-fragment eye-horizon cull — identical to the polygon / raster fill
      // paths, so the occluder silhouette coincides with the fill limb (no
      // colour ring past the true limb; INC-1 trap 2).
      const cosC = needs_backface_cull(
        pin.abs_lon,
        pin.abs_lat,
        U.field.proj_params,
        U.field.globe_eye,
      )
      If(cosC.lt(0), () => {
        Discard()
      })
      // Rim fade matches the fill's soft limb edge; the interior stays fully
      // opaque (rim = 1) so a crack over the interior bleeds to the sphere colour.
      const rim = rim_alpha(pin.abs_lon, pin.abs_lat, U.field.proj_params, U.field.globe_eye)
      const col = U.field.color
      return OccluderFragmentOutput.construct({
        color: vec4(col.x, col.y, col.z, col.w.mul(rim)),
        ...(pickEnabled ? { pick: vec2u(0, 0) } : {}),
        depth: compute_log_frag_depth({ view_w: pin.view_w, fc: U.field.proj_params.w }),
      })
    },
    { stage: 'fragment' },
  )
}

export const buildUnderOccluderModule = (pickEnabled: boolean): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
    structs: [U.struct, VsOut.decl, occluderFragmentOutput(pickEnabled).decl],
    bindings: [U.binding],
    funcs: [
      // Injection seam (#740 R1): the projection fns (needs_backface_cull /
      // rim_alpha and their proj_globe callees) are extern-called, so module()
      // cannot auto-collect them — supply them explicitly. log-depth helpers are
      // handle-called and collected callee-first.
      ...getGpuProjectionFuncs(),
      vs,
      buildFs(pickEnabled),
    ],
  })

/** Full under-occluder shader (globe-7 solid sphere). `pickEnabled` toggles the
 *  rg32uint pick attachment field + a (0,0) write so the pipeline's colour-target
 *  count matches the opaque pass's pick MRT when picking is on. */
export const emitUnderOccluderWgsl = (pickEnabled: boolean): string =>
  emitModule(buildUnderOccluderModule(pickEnabled))

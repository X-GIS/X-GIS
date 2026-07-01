// ═══ Frame projection + cull uniform — the SINGLE coupled writer ═══
//
// `proj_params` (projType, center lon/lat) and `globe_eye` (the globe(7)
// eye-horizon cull vector) are ONE semantic unit: proj_params says "we are on the
// globe", globe_eye says "and here is the eye the cull needs". They are both
// frame-invariant (identical for every renderer in a frame) and both derived from
// the same (projType, center, camera-eye) inputs.
//
// #600 wrote them SEPARATELY across six hand-packed CPU writers and missed
// globe_eye in three of them → the globe cull silently fell back to the centre-
// hemisphere model and leaked far-side geometry (#663). The fix-the-class move
// (ADR-0009) is to make a partial write UNREPRESENTABLE: there is now ONE function
// that writes BOTH fields together, so a caller cannot set the projection without
// also setting the eye. This RETIRES frame-uniform-writer-completeness.test.ts (the
// stop-gap that scanned for the missing write).
//
// LAZY: reads polygonUniformSlots() (a reflect/projection emit) at call time — so
// call it at draw/frame time, never from a module-level const / static field
// (enforced by no-eager-uniform-reflect.test.ts).

import { polygonUniformSlots } from '@xgis/map'
import { globeEyeUniform } from '@xgis/map'

/** Write `proj_params` + `globe_eye` TOGETHER into a uniform `f32` view, at the
 *  caller's slot indices. This is the generic coupled writer EVERY render family
 *  uses (polygon/line, raster, point, heatmap) — the two fields are one semantic
 *  unit ("we're on the globe" + "the eye the cull needs"), so coupling them in one
 *  call makes the #600 "projection set, eye forgotten" partial write unrepresentable.
 *
 *  `projParamsW` is `proj_params.w`: 0 for most families, but the RASTER struct
 *  folds `log_depth_fc` into that lane — pass it there. `eye` is the absolute
 *  sphere-ECEF camera position on the globe/ECEF branch (undefined off the globe →
 *  globe_eye all-zero, which the flat/disc cull arms ignore). */
export function writeProjectionCull(
  f32: Float32Array,
  projParamsSlot: number,
  globeEyeSlot: number,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  eye?: readonly [number, number, number],
  projParamsW = 0,
): void {
  f32[projParamsSlot] = projType
  f32[projParamsSlot + 1] = projCenterLon
  f32[projParamsSlot + 2] = projCenterLat
  f32[projParamsSlot + 3] = projParamsW
  const ge = globeEyeUniform(eye)
  f32[globeEyeSlot] = ge[0]
  f32[globeEyeSlot + 1] = ge[1]
  f32[globeEyeSlot + 2] = ge[2]
  f32[globeEyeSlot + 3] = ge[3]
}

/** Polygon/line group(0) convenience over writeProjectionCull — resolves the
 *  reflected polygon slots (proj_params.w = 0). The three group(0) writers
 *  (vector-tile-renderer / renderer.renderToPass / graticule) call this. */
export function writeFrameProjectionUniform(
  f32: Float32Array,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  eye?: readonly [number, number, number],
): void {
  const S = polygonUniformSlots().slot
  writeProjectionCull(f32, S.proj_params, S.globe_eye, projType, projCenterLon, projCenterLat, eye, 0)
}

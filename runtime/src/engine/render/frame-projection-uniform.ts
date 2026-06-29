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

import { polygonUniformSlots } from './polygon-uniform-slots'
import { globeEyeUniform } from './globe-eye-uniform'

/** Write `proj_params` + `globe_eye` into the polygon/line group(0) uniform `f32`
 *  view (whole-buffer Float32Array; all three group(0) writers share the polygon
 *  Uniforms layout). `eye` is the absolute sphere-ECEF camera position on the
 *  globe/ECEF branch (undefined off the globe → globe_eye all-zero, which the
 *  flat/disc cull arms ignore). The two fields are written together so the #600
 *  "projection set, eye forgotten" drift cannot recur. */
export function writeFrameProjectionUniform(
  f32: Float32Array,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  eye?: readonly [number, number, number],
): void {
  const S = polygonUniformSlots().slot
  f32[S.proj_params] = projType
  f32[S.proj_params + 1] = projCenterLon
  f32[S.proj_params + 2] = projCenterLat
  f32[S.proj_params + 3] = 0
  const ge = globeEyeUniform(eye)
  f32[S.globe_eye] = ge[0]
  f32[S.globe_eye + 1] = ge[1]
  f32[S.globe_eye + 2] = ge[2]
  f32[S.globe_eye + 3] = ge[3]
}

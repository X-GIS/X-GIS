// Unit + coupling parity for writeFrameProjectionUniform — the single writer of
// proj_params + globe_eye for the polygon/line group(0) family (ADR-0009).

import { describe, it, expect } from 'vitest'
import { writeFrameProjectionUniform, writeProjectionCull } from '@xgis/map'
import { polygonUniformBytes, polygonUniformSlots } from '@xgis/map'
import { globeEyeUniform } from '@xgis/map'
import { buildGlobeMatrix } from '@xgis/engine'

function freshBuffer(): Float32Array {
  return new Float32Array(polygonUniformBytes() / 4)
}

describe('writeFrameProjectionUniform — coupled proj_params + globe_eye writer', () => {
  it('writes proj_params [projType, clon, clat, 0] at the reflected slot', () => {
    const f32 = freshBuffer()
    const S = polygonUniformSlots().slot
    writeFrameProjectionUniform(f32, 7, 127, 37, undefined)
    expect([
      f32[S.proj_params],
      f32[S.proj_params + 1],
      f32[S.proj_params + 2],
      f32[S.proj_params + 3],
    ]).toEqual([7, 127, 37, 0])
  })

  it('on the globe, globe_eye equals globeEyeUniform(eye) — both fields written by ONE call', () => {
    const f32 = freshBuffer()
    const S = polygonUniformSlots().slot
    const eye = buildGlobeMatrix(0, 0, 2.2, 0, 0, 1280, 720).eye as readonly [
      number,
      number,
      number,
    ]
    writeFrameProjectionUniform(f32, 7, 0, 0, eye)
    const ge = globeEyeUniform(eye)
    // f32 storage rounds the f64 helper output — compare against the fround'd value.
    expect([
      f32[S.globe_eye],
      f32[S.globe_eye + 1],
      f32[S.globe_eye + 2],
      f32[S.globe_eye + 3],
    ]).toEqual([Math.fround(ge[0]), Math.fround(ge[1]), Math.fround(ge[2]), Math.fround(ge[3])])
    // The w lane (R/|eye|) is the "globe_eye written" sentinel — must be > 0 so the
    // shader takes the eye-horizon arm, not the centre-hemisphere fallback (#600).
    expect(f32[S.globe_eye + 3]).toBeGreaterThan(0)
  })

  it('off the globe (no eye) globe_eye is all-zero (flat/disc cull arms ignore it)', () => {
    const f32 = freshBuffer()
    const S = polygonUniformSlots().slot
    writeFrameProjectionUniform(f32, 0, 0, 0, undefined)
    expect([
      f32[S.globe_eye],
      f32[S.globe_eye + 1],
      f32[S.globe_eye + 2],
      f32[S.globe_eye + 3],
    ]).toEqual([0, 0, 0, 0])
  })

  it('generic writeProjectionCull honours caller slots + proj_params.w (raster log_depth_fc)', () => {
    // Arbitrary slot layout (proj at 4, eye at 12) + the raster-style proj_params.w
    // = log_depth_fc lane. Proves the generic writer (used by raster/heatmap/point)
    // couples both fields at the caller's offsets without hardcoding the polygon layout.
    const f32 = new Float32Array(20)
    const eye = buildGlobeMatrix(0, 0, 2.2, 0, 0, 1280, 720).eye as readonly [
      number,
      number,
      number,
    ]
    writeProjectionCull(f32, 4, 12, 7, 10, 20, eye, 0.5)
    expect([f32[4], f32[5], f32[6], f32[7]]).toEqual([7, 10, 20, 0.5]) // proj_params incl. .w
    const ge = globeEyeUniform(eye)
    expect([f32[12], f32[13], f32[14], f32[15]]).toEqual([
      Math.fround(ge[0]),
      Math.fround(ge[1]),
      Math.fround(ge[2]),
      Math.fround(ge[3]),
    ])
  })
})

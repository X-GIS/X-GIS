// ═══ Point frame-uniform byte-equality gate (#733 P1) ═══
//
// The migration contract: writePointFrameUniform's UniformBlock pack emits bytes
// IDENTICAL to the lane-arithmetic writer it replaced — so the real-GPU render is
// DC=0 by construction. Two anchors:
//
//   1. REFERENCE BYTES — a frozen verbatim copy of the retired lane writer
//      (fixed slots: mvp 0, proj_params 16, viewport 20, cam_ecef_h 24,
//      cam_ecef_l 28, circle_params 32, globe_eye 36 — 40 f32 slots / 160 B)
//      packed over a fixture matrix (flat centre / globe ECEF+eye / translate+
//      blur+pitch-scale / degenerate 0×0 canvas) must equal the block bytes.
//   2. LAYOUT PARITY — uniformBlock(U) (handle-only wgslLayout path) resolves
//      the SAME field offsets/size as reflect(buildPointModule()) (the module
//      path the renderer's bind-group layout still derives from).
//
// The reference deliberately re-implements the old math inline (including the
// writeProjectionCull coupling) rather than importing helpers — it is the
// byte-level spec of what the shader consumed before the migration.

import { describe, it, expect } from 'vitest'
import type { Camera } from '@xgis/engine'
import { WORLD_MERC, TILE_PX, uniformBlock } from '@xgis/engine'
import { reflect } from '@xgis/shader-dsl'
import { buildPointModule, pointU as POINT_U } from '../shaders/dsl/point'
import { writePointFrameUniform } from './point-renderer'
import { globeEyeUniform } from './globe-eye-uniform'

interface Fixture {
  readonly name: string
  readonly projType: number
  readonly projCenterLon: number
  readonly projCenterLat: number
  readonly eye?: readonly [number, number, number]
  readonly canvasWidth: number
  readonly canvasHeight: number
  readonly circleTranslateX: number
  readonly circleTranslateY: number
  readonly circleBlur: number
  readonly circlePitchScaleMap: boolean
}

const MVP = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 0.5)
const LOG_DEPTH_FC = 0.123456
const CAM = {
  zoom: 5.25,
  centerX: 0.31234567890123,
  centerY: 0.65987654321098,
  getECEFCenter: () => [1234567.891234, -7654321.987654, 3456789.123456] as const,
} as unknown as Camera

const FIXTURES: readonly Fixture[] = [
  {
    name: 'flat mercator (projType 0), defaults',
    projType: 0, projCenterLon: 0, projCenterLat: 0,
    canvasWidth: 1280, canvasHeight: 720,
    circleTranslateX: 0, circleTranslateY: 0, circleBlur: 0, circlePitchScaleMap: false,
  },
  {
    name: 'flat mercator with translate/blur/pitch-scale:map',
    projType: 0, projCenterLon: 0, projCenterLat: 0,
    canvasWidth: 800, canvasHeight: 600,
    circleTranslateX: 12.5, circleTranslateY: -7.25, circleBlur: 1.5, circlePitchScaleMap: true,
  },
  {
    name: 'globe (projType 7) with eye — #600 globe_eye lanes live',
    projType: 7, projCenterLon: 127.024, projCenterLat: 37.532,
    eye: [12756274.1, 1234567.8, -7654321.9],
    canvasWidth: 1920, canvasHeight: 1080,
    circleTranslateX: 3, circleTranslateY: 4, circleBlur: 0.25, circlePitchScaleMap: false,
  },
  {
    name: 'degenerate 0×0 canvas (translate divide guards)',
    projType: 6, projCenterLon: -45.5, projCenterLat: 62.25,
    canvasWidth: 0, canvasHeight: 0,
    circleTranslateX: 10, circleTranslateY: 10, circleBlur: 2, circlePitchScaleMap: true,
  },
]

/** Frozen verbatim reference: the retired lane-arithmetic writer, fixed slots. */
function referenceBytes(f: Fixture): Uint8Array {
  const uf = new Float32Array(40)
  const U_MVP = 0, U_PROJ = 16, U_VIEWPORT = 20, U_CAM_H = 24, U_CAM_L = 28, U_CIRCLE = 32, U_EYE = 36
  uf.set(MVP, U_MVP)
  // writeProjectionCull inline: proj_params + globe_eye as one coupled unit.
  uf[U_PROJ] = f.projType
  uf[U_PROJ + 1] = f.projCenterLon
  uf[U_PROJ + 2] = f.projCenterLat
  uf[U_PROJ + 3] = 0
  const ge = globeEyeUniform(f.eye)
  uf[U_EYE] = ge[0]; uf[U_EYE + 1] = ge[1]; uf[U_EYE + 2] = ge[2]; uf[U_EYE + 3] = ge[3]
  const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, (CAM as { zoom: number }).zoom)
  uf[U_VIEWPORT] = f.canvasWidth; uf[U_VIEWPORT + 1] = f.canvasHeight
  uf[U_VIEWPORT + 2] = metersPerPixel; uf[U_VIEWPORT + 3] = LOG_DEPTH_FC
  if (f.projType === 0) {
    const cmx = (CAM as { centerX: number }).centerX, cmy = (CAM as { centerY: number }).centerY
    const cmxH = Math.fround(cmx), cmyH = Math.fround(cmy)
    uf[U_CAM_H] = cmxH; uf[U_CAM_H + 1] = cmyH; uf[U_CAM_H + 2] = 0; uf[U_CAM_H + 3] = 0
    uf[U_CAM_L] = cmx - cmxH; uf[U_CAM_L + 1] = cmy - cmyH; uf[U_CAM_L + 2] = 0; uf[U_CAM_L + 3] = 0
  } else {
    const camC = CAM.getECEFCenter()
    const cxH = Math.fround(camC[0]); const cyH = Math.fround(camC[1]); const czH = Math.fround(camC[2])
    uf[U_CAM_H] = cxH; uf[U_CAM_H + 1] = cyH; uf[U_CAM_H + 2] = czH; uf[U_CAM_H + 3] = 0
    uf[U_CAM_L] = camC[0] - cxH; uf[U_CAM_L + 1] = camC[1] - cyH; uf[U_CAM_L + 2] = camC[2] - czH; uf[U_CAM_L + 3] = 0
  }
  uf[U_CIRCLE] = f.canvasWidth > 0 ? (f.circleTranslateX * 2) / f.canvasWidth : 0
  uf[U_CIRCLE + 1] = f.canvasHeight > 0 ? -(f.circleTranslateY * 2) / f.canvasHeight : 0
  uf[U_CIRCLE + 2] = f.circleBlur
  uf[U_CIRCLE + 3] = f.circlePitchScaleMap ? 1 : 0
  return new Uint8Array(uf.buffer.slice(0))
}

describe('point frame uniform — block bytes ≡ retired lane writer', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const block = uniformBlock(POINT_U)
      writePointFrameUniform(
        block,
        { matrix: MVP, logDepthFc: LOG_DEPTH_FC, ...(f.eye ? { eye: f.eye } : {}) },
        CAM, f.projType, f.projCenterLon, f.projCenterLat,
        f.canvasWidth, f.canvasHeight,
        f.circleTranslateX, f.circleTranslateY, f.circleBlur, f.circlePitchScaleMap,
      )
      expect(block.byteLength).toBe(160)
      expect([...new Uint8Array(block.buffer)]).toEqual([...referenceBytes(f)])
    })
  }
})

describe('point Uniforms layout — handle path ≡ reflected module path', () => {
  it('uniformBlock(U) offsets/size match reflect(buildPointModule())', () => {
    const block = uniformBlock(POINT_U)
    const reflected = reflect(buildPointModule()).uniforms.find((u) => u.name === 'Uniforms')!
    expect(reflected).toBeDefined()
    expect(block.byteLength).toBe(reflected.size)
    for (const fl of reflected.fields) {
      expect(block.fieldOffset(fl.name as never)).toBe(fl.offset)
    }
  })
})

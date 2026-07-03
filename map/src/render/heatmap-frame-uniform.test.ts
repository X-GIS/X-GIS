// ═══ Heatmap frame-uniform byte-equality gate (#733 P2a) ═══
//
// Same contract as point-frame-uniform.test.ts: writeHeatmapFrameUniform's
// UniformBlock pack must emit bytes IDENTICAL to the lane-arithmetic writer it
// replaced (fixed slots: mvp 0, proj_params 16, viewport 20, cam_ecef_h 24,
// cam_ecef_l 28, globe_eye 32 — 36 f32 slots / 144 B), plus layout parity of the
// handle-only wgslLayout path against reflect(buildHeatmapAccumModule()).

import { describe, it, expect } from 'vitest'
import type { Camera } from '@xgis/engine'
import { WORLD_MERC, TILE_PX, uniformBlock } from '@xgis/engine'
import { reflect } from '@xgis/shader-dsl'
import { buildHeatmapAccumModule, heatmapAccumU as HEATMAP_U } from '../shaders/dsl/heatmap-accum'
import { writeHeatmapFrameUniform } from './heatmap-renderer'
import { globeEyeUniform } from './globe-eye-uniform'

interface Fixture {
  readonly name: string
  readonly projType: number
  readonly projCenterLon: number
  readonly projCenterLat: number
  readonly eye?: readonly [number, number, number]
  readonly canvasWidth: number
  readonly canvasHeight: number
}

const MVP = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 0.25)
const CAM = {
  zoom: 4.75,
  centerX: 0.21234567890123,
  centerY: 0.55987654321098,
  getECEFCenter: () => [2234567.891234, -6654321.987654, 2456789.123456] as const,
} as unknown as Camera

const FIXTURES: readonly Fixture[] = [
  {
    name: 'flat mercator (projType 0) — 2D centre DSFUN branch',
    projType: 0,
    projCenterLon: 0,
    projCenterLat: 0,
    canvasWidth: 1280,
    canvasHeight: 720,
  },
  {
    name: 'globe (projType 7) with eye — #600 globe_eye lanes live',
    projType: 7,
    projCenterLon: 127.024,
    projCenterLat: 37.532,
    eye: [12756274.1, 1234567.8, -7654321.9],
    canvasWidth: 1920,
    canvasHeight: 1080,
  },
  {
    name: 'non-merc flat (projType 6), no eye — ECEF centre + zero globe_eye',
    projType: 6,
    projCenterLon: -45.5,
    projCenterLat: 62.25,
    canvasWidth: 800,
    canvasHeight: 600,
  },
]

/** Frozen verbatim reference: the retired lane-arithmetic writer, fixed slots. */
function referenceBytes(f: Fixture): Uint8Array {
  const uf = new Float32Array(36)
  const HS_MVP = 0,
    HS_PROJ = 16,
    HS_VIEWPORT = 20,
    HS_CAM_H = 24,
    HS_CAM_L = 28,
    HS_EYE = 32
  uf.set(MVP, HS_MVP)
  uf[HS_PROJ] = f.projType
  uf[HS_PROJ + 1] = f.projCenterLon
  uf[HS_PROJ + 2] = f.projCenterLat
  uf[HS_PROJ + 3] = 0
  const ge = globeEyeUniform(f.eye)
  uf[HS_EYE] = ge[0]
  uf[HS_EYE + 1] = ge[1]
  uf[HS_EYE + 2] = ge[2]
  uf[HS_EYE + 3] = ge[3]
  const metersPerPixel = WORLD_MERC / TILE_PX / Math.pow(2, (CAM as { zoom: number }).zoom)
  uf[HS_VIEWPORT] = f.canvasWidth
  uf[HS_VIEWPORT + 1] = f.canvasHeight
  uf[HS_VIEWPORT + 2] = metersPerPixel
  uf[HS_VIEWPORT + 3] = 0
  if (f.projType === 0) {
    const cmx = (CAM as { centerX: number }).centerX,
      cmy = (CAM as { centerY: number }).centerY
    const cmxH = Math.fround(cmx),
      cmyH = Math.fround(cmy)
    uf[HS_CAM_H] = cmxH
    uf[HS_CAM_H + 1] = cmyH
    uf[HS_CAM_H + 2] = 0
    uf[HS_CAM_H + 3] = 0
    uf[HS_CAM_L] = cmx - cmxH
    uf[HS_CAM_L + 1] = cmy - cmyH
    uf[HS_CAM_L + 2] = 0
    uf[HS_CAM_L + 3] = 0
  } else {
    const camC = CAM.getECEFCenter()
    const cxH = Math.fround(camC[0])
    const cyH = Math.fround(camC[1])
    const czH = Math.fround(camC[2])
    uf[HS_CAM_H] = cxH
    uf[HS_CAM_H + 1] = cyH
    uf[HS_CAM_H + 2] = czH
    uf[HS_CAM_H + 3] = 0
    uf[HS_CAM_L] = camC[0] - cxH
    uf[HS_CAM_L + 1] = camC[1] - cyH
    uf[HS_CAM_L + 2] = camC[2] - czH
    uf[HS_CAM_L + 3] = 0
  }
  return new Uint8Array(uf.buffer.slice(0))
}

describe('heatmap frame uniform — block bytes ≡ retired lane writer', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const block = uniformBlock(HEATMAP_U)
      writeHeatmapFrameUniform(
        block,
        { matrix: MVP, ...(f.eye ? { eye: f.eye } : {}) },
        CAM,
        f.projType,
        f.projCenterLon,
        f.projCenterLat,
        f.canvasWidth,
        f.canvasHeight,
      )
      expect(block.byteLength).toBe(144)
      expect([...new Uint8Array(block.buffer)]).toEqual([...referenceBytes(f)])
    })
  }
})

describe('heatmap Uniforms layout — handle path ≡ reflected module path', () => {
  it('uniformBlock(U) offsets/size match reflect(buildHeatmapAccumModule())', () => {
    const block = uniformBlock(HEATMAP_U)
    const reflected = reflect(buildHeatmapAccumModule()).uniforms.find(
      (u) => u.name === 'Uniforms',
    )!
    expect(reflected).toBeDefined()
    expect(block.byteLength).toBe(reflected.size)
    for (const fl of reflected.fields) {
      expect(block.fieldOffset(fl.name as never)).toBe(fl.offset)
    }
  })
})

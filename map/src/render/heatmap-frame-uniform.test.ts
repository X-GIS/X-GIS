// ═══ Heatmap frame-uniform byte-equality gate (#733 P2a) ═══
//
// Same contract as point-frame-uniform.test.ts: writeHeatmapFrameUniform's
// UniformBlock pack must emit bytes IDENTICAL to the lane-arithmetic writer it
// replaced (fixed slots: mvp 0, proj_params 16, viewport 20, cam_ecef_h 24,
// cam_ecef_l 28, globe_eye 32 — 36 f32 slots / 144 B), plus layout parity of the
// handle-only wgslLayout path against reflect(buildHeatmapAccumModule()).

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { uniformBlock } from '@xgis/engine'
import { WORLD_MERC, TILE_PX, flatViewHeightCapM, isGlobeProj } from '@xgis/geo'
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
const CAM_ZOOM = 4.75
const CAM = {
  zoom: CAM_ZOOM,
  centerX: 0.21234567890123,
  centerY: 0.55987654321098,
  getECEFCenter: () => [2234567.891234, -6654321.987654, 2456789.123456] as const,
  // #964 — mirror Camera.effectiveMpp for the fixtures (no `this`: the cast
  // literal types `this` as {}). CAM is never in globeMode; projType 7 routes via
  // isGlobeProj. At zoom 4.75 the raw view height is far below every projType's
  // cap, so effectiveMpp === rawMpp and the retired-lane reference bytes (raw mpp)
  // still hold: DC=0 above the sub-cap band, the migration contract this gate pins.
  effectiveMpp(projType: number, canvasHeight: number, dpr: number): number {
    const rawMpp = WORLD_MERC / TILE_PX / Math.pow(2, CAM_ZOOM)
    if (isGlobeProj(projType)) return rawMpp
    return Math.min(rawMpp, flatViewHeightCapM(projType, WORLD_MERC) / (canvasHeight / dpr))
  },
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
        1, // dpr — effectiveMpp collapses to raw mpp above the sub-cap band
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

// ═══ #964 — the heatmap consumer must pack the CAPPED effective mpp ═══
//
// The byte-equality fixtures above run at CAM_ZOOM 4.75, where the view-height cap
// never binds and effectiveMpp === rawMpp — so they'd stay green even if
// writeHeatmapFrameUniform were reverted to the uncapped WORLD_MERC/TILE_PX/2^zoom
// (the #964 raw-mpp read). This block pins the CONSUMER wiring (heatmap-renderer.ts's
// `camera.effectiveMpp(projType, canvasHeight, dpr)`) with a REAL Camera in the
// sub-cap band, so the packed viewport.z lane is the capped value and a raw-mpp
// re-inline (the #722-729 render-antipattern archetype) fails here instead of
// shipping the divergence silently — mirroring point-frame-uniform.test.ts (#739).
//
// NOTE: viewport.z (meters/px) is currently UNREAD by the accum shader (the splat
// radius is CSS px expanded via viewport.x/y), so this switch is single-authority
// hygiene — byte-inert on-GPU today — not a visible-size fix. The gate still pins
// the lane's VALUE so it stays truthful under the effective-mpp authority.
describe('heatmap frame uniform — sub-cap band packs the capped effective mpp (#964)', () => {
  it('viewport.z lane = min(rawMpp, cap/cssH), strictly below the uncapped 2^zoom mpp', () => {
    // z0 on a tall CSS viewport: z* = log2(1080/512) ≈ 1.08, so z0 is INSIDE the
    // frozen sub-cap band and the flat view-height cap binds (capped < raw).
    const cssH = 1080
    const dpr = 1
    const cam = new Camera(0, 0, 0)
    cam.projType = 0
    cam.bearing = 0
    cam.globeMode = false

    const block = uniformBlock(HEATMAP_U)
    writeHeatmapFrameUniform(
      block,
      { matrix: MVP },
      cam,
      0, // projType — flat mercator
      0, // projCenterLon
      0, // projCenterLat
      1920, // canvasWidth (device px)
      cssH, // canvasHeight (device px; dpr=1 → CSS px)
      dpr,
    )

    const rawMpp = WORLD_MERC / TILE_PX / Math.pow(2, 0)
    const capped = Math.min(rawMpp, flatViewHeightCapM(0, WORLD_MERC) / (cssH / dpr))
    // Fixture sanity: the cap MUST bind here or the gate proves nothing (raw ≠ capped).
    expect(capped).toBeLessThan(rawMpp)

    // viewport lane = [w, h, metersPerPixel, 0] → the mpp sits at z (index 2).
    const packed = new Float32Array(block.buffer)
    const viewportZ = packed[block.fieldOffset('viewport' as never) / 4 + 2]
    // The consumer packed the CAPPED effective mpp…
    expect(viewportZ).toBe(Math.fround(capped))
    // …NOT the uncapped raw mpp (the reverted #964 read would pack this instead).
    expect(viewportZ).not.toBe(Math.fround(rawMpp))
  })
})

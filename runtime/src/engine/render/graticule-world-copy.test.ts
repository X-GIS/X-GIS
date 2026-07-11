// #729 — the graticule fans its grid across the SAME world copies the fills
// occupy on flat display, instead of the single absolute-ECEF pass the ECEF
// migration wrongly left it with (`for (let wi = 0; wi < 1; wi++)` + a stale
// 'cam_h unused — ECEF path' comment that is FALSE for flat Mercator).
//
// ── Oracle ─────────────────────────────────────────────────────────────────
// We drive the REAL GraticuleRenderer.renderFrame against a stub GPU pass + ring
// and a REAL Camera (pure matrix math — no GPU). Each per-copy draw stages the
// polygon 'Uniforms' block through ring.stageSlot; we snapshot that ArrayBuffer
// per draw and read tile_origin_merc.x (float 32) + cam_h.x (float 28) — the two
// slots that carry the per-copy world offset. Assertions:
//   • flat Mercator low-zoom+pitch → one draw PER visible world copy (fan-out),
//     each copy carrying tile_origin_merc.x = wo·worldWidth and
//     cam_h.x = fround(camMerc.x − wo·worldWidth).  [pre-fix: exactly ONE draw]
//   • globe(7) → the single ECEF pass is preserved (one draw, frame.mvp used,
//     getViewForProjection NOT consulted).
//
// Pre-fix this fails: the `for wi<1` loop issues exactly one draw regardless of
// how many world copies are visible, so the flat-Mercator draw count is 1, not
// copies.length (> 1 in this camera state).

import { describe, it, expect } from 'vitest'
import { GraticuleRenderer, Camera, type GraticuleCamera } from '@xgis/map'
import type { GPUContext } from '@xgis/rhi-webgpu'

// GPUBufferUsage is a WebGPU global absent under vitest; the stubbed
// createBuffer ignores the flags, so any bitmask values suffice.
;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= { VERTEX: 0x20, COPY_DST: 0x8 }

const R = 6378137
const WORLD_WIDTH = 2 * Math.PI * R
const TILE_ORIGIN_X_F32 = 32 // float index of tile_origin_merc.x in polygon Uniforms
const CAM_H_X_F32 = 28 // float index of cam_h.x

/** Minimal GPUContext: renderFrame only touches ctx.device.createBuffer +
 *  queue.writeBuffer (via initGraticule). */
function stubCtx(): GPUContext {
  return {
    device: {
      createBuffer: () => ({ destroy: () => undefined }),
      queue: { writeBuffer: () => undefined },
    },
  } as unknown as GPUContext
}

interface Draw {
  bytes: Float32Array
}

/** A stub pass + ring that snapshots each staged uniform block per draw. */
function harness() {
  const draws: Draw[] = []
  let pending: Float32Array | null = null
  const ring = {
    allocSlot: () => 0,
    // src is the reused polygon-uniform ArrayBuffer — COPY it (the next copy
    // overwrites the same backing store, exactly as the real ring does).
    stageSlot: (_off: number, src: ArrayBuffer) => {
      pending = new Float32Array(src.slice(0))
    },
  }
  const pass = {
    setPipeline: () => undefined,
    setVertexBuffer: () => undefined,
    setBindGroup: () => undefined,
    draw: () => {
      draws.push({ bytes: pending! })
    },
  }
  return { draws, ring, pass }
}

function camAt(projType: number, zoom: number, lon: number, lat: number, pitch = 0, bearing = 0) {
  const c = new Camera()
  const DEG2RAD = Math.PI / 180
  c.centerX = lon * DEG2RAD * R
  c.centerY = Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) * R
  c.zoom = zoom
  c.pitch = pitch
  c.bearing = bearing
  c.projType = projType
  c.globeMode = false
  return c
}

const W = 800,
  H = 600,
  DPR = 1

function frameFor(camera: Camera, projType: number, projCenterLon: number, projCenterLat: number) {
  // frame.mvp is only read on the ECEF fast path — an ECEF frame view is the
  // production source (renderer.ts). eye present only off-flat.
  const ecef = camera.getECEFFrameView(W, H, DPR)
  return {
    mvp: ecef.matrix,
    logDepthFc: ecef.logDepthFc,
    projType,
    projCenterLon,
    projCenterLat,
    zoom: camera.zoom,
    eye: ecef.eye,
  }
}

describe('graticule world-copy fan-out (#729)', () => {
  it('flat Mercator draws once PER visible world copy, with per-copy world offset', () => {
    // Extreme-pitch low-zoom view stretches the frustum across worlds.
    const camera = camAt(0, 0, -54, 0, 63, 90)
    const copies = camera.getVisibleWorldCopies(W, H, DPR)
    expect(copies.length, 'guard: camera state must expose >1 world copy').toBeGreaterThan(1)

    const g = new GraticuleRenderer(stubCtx())
    g.setEnabled(true)
    const { draws, ring, pass } = harness()
    g.renderFrame(
      pass as never,
      {} as never,
      {} as never,
      ring as never,
      frameFor(camera, 0, -54, 0),
      camera as GraticuleCamera,
      W,
      H,
      DPR,
    )

    // One draw per visible world copy — the fan-out the ECEF migration dropped.
    expect(draws.length).toBe(copies.length)

    // Each copy carries its own world offset in tile_origin_merc.x + cam_h.x.
    // camMerc.x = lonLatToMercator(projCenterLon).x = camera.centerX for Mercator.
    const camX = camera.centerX
    for (let i = 0; i < copies.length; i++) {
      const wo = copies[i]!
      const tileOx = draws[i]!.bytes[TILE_ORIGIN_X_F32]!
      const camHx = draws[i]!.bytes[CAM_H_X_F32]!
      // The uniform is a Float32Array, so both slots hold the f32-rounded value.
      expect(tileOx, `copy ${wo} tile_origin_merc.x`).toBe(Math.fround(wo * WORLD_WIDTH))
      expect(camHx, `copy ${wo} cam_h.x`).toBe(Math.fround(camX - wo * WORLD_WIDTH))
    }

    // The per-copy packs genuinely differ (not N identical draws).
    const distinctOffsets = new Set(draws.map((d) => d.bytes[TILE_ORIGIN_X_F32]))
    expect(distinctOffsets.size).toBe(copies.length)
  })

  it('globe(7) keeps the single absolute-ECEF pass (one draw, frame.mvp, no flat MVP)', () => {
    const camera = camAt(7, 2, 0, 0)
    camera.globeMode = true
    let flatMvpConsulted = false
    const spyCam = new Proxy(camera as GraticuleCamera, {
      get(target, prop, recv) {
        if (prop === 'getViewForProjection') {
          return (...args: Parameters<GraticuleCamera['getViewForProjection']>) => {
            flatMvpConsulted = true
            return target.getViewForProjection(...args)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    })

    const g = new GraticuleRenderer(stubCtx())
    g.setEnabled(true)
    const { draws, ring, pass } = harness()
    const frame = frameFor(camera, 7, 0, 0)
    g.renderFrame(pass as never, {} as never, {} as never, ring as never, frame, spyCam, W, H, DPR)

    expect(draws.length, 'globe → single ECEF pass').toBe(1)
    expect(flatMvpConsulted, 'globe must NOT route through the flat getViewForProjection').toBe(
      false,
    )
    // The ECEF pass draws in the primary world only (no per-copy offset).
    expect(draws[0]!.bytes[TILE_ORIGIN_X_F32]).toBe(0)
  })
})

// #1477 — the raster tile fade ramp advanced on FRAME COUNT (assumed a hard
// 60fps), not the frame clock, so a 30fps host took 2× the requested
// `rasterFadeDuration` to finish and a 120fps host finished in HALF the
// requested time. This drives the REAL RasterRenderer.render() against the
// WebGPU stub (same harness as raster-zoom-out-crossfade.test.ts), stepping
// an EXPLICIT `nowMs` clock, and reads back the per-tile fade alpha from the
// pooled 48-byte TileUniforms write (`tile_ecef_center.w`, f32 slot 7 —
// raster.ts VsOut.vis) that vs_tile forwards to the fragment's alpha.
//
// ── Fail-before derivation (pre-fix raster-renderer.ts) ──────────────────
// Old ramp: fadeFrames = fadeDurationMs * 0.06 (frames, hard 60fps); on each
// render() call frameCount increments by exactly 1 regardless of the wall
// clock, and fadeAlpha = min(1, (frameCount − firstShownFrame) / fadeFrames).
// At fadeDurationMs=300, fadeFrames = 18.
//
//   30fps (33.33ms/frame): stepping nowMs by 33.33ms until it first reaches
//   300ms takes 9 steps past the initial render, i.e. frameCount=10 when the
//   wall clock says the fade should be COMPLETE. Old fadeAlpha at
//   frameCount=10 = (10−1)/18 ≈ 0.5 — still HALF faded, not done. The ramp
//   does not finish until frameCount reaches 18, i.e. 18×33.33 ≈ 600ms —
//   2× the requested 300ms.
//
//   120fps (8.33ms/frame): stepping nowMs to 250ms (still short of the
//   300ms duration) takes about 30 render() calls. Old fadeAlpha at
//   frameCount=30 = min(1, 29/18) = 1 — ALREADY DONE. The ramp actually
//   finished at frameCount=18, i.e. 18×8.33 ≈ 150ms — HALF the requested
//   duration.
//
// Both assertions below therefore FAIL against the pre-fix frame-counted
// ramp and PASS once the ramp is measured against nowMs directly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer, rasterCoverZoom, Camera } from '@xgis/map'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/geo'
import { rasterTileBytes } from './raster-uniform-slots'

let stub: StubInstallation
beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => stub.uninstall())

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const W = 1280
const H = 720
const DPR = 1
type CacheEntry = { texture: unknown; lastUsedFrame: number; firstShownMs: number }
const fakeTexture = { createView: () => ({}), destroy: () => undefined }

function flatCamera(): Camera {
  const camera = new Camera(0, 0, 3)
  camera.projType = 0
  return camera
}

function seedTargets(renderer: RasterRenderer, camera: Camera): void {
  const currentZ = rasterCoverZoom(camera.zoom, 256)
  const cache = (renderer as unknown as { tileCache: Map<string, CacheEntry> }).tileCache
  for (const t of visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR))
    cache.set(`${t.z}/${t.x}/${t.y}`, { texture: fakeTexture, lastUsedFrame: 0, firstShownMs: -1 })
}

/** Render once at `nowMs`, intercepting the pooled 48-byte per-tile uniform write
 *  to read back `tile_ecef_center.w` (f32 slot 7) — the per-tile fade alpha. */
function renderAndCaptureAlpha(
  ctx: GPUContext,
  renderer: RasterRenderer,
  camera: Camera,
  nowMs: number,
): number {
  let alpha = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (b: unknown, o: number, d: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== rasterTileBytes()) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            12,
          )
    alpha = f32[7]
  }
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(wrapWebGpuPass(encoder.beginRenderPass()), camera, 0, 0, 0, W, H, nowMs, DPR)
  return alpha
}

describe('raster tile fade ramps on the wall clock, not frame count (#1477)', () => {
  it('30fps host: the ramp completes at 300ms elapsed (~10 frames, not ~18)', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    renderer.setRasterFadeDurationMs(300)
    const camera = flatCamera()
    seedTargets(renderer, camera)

    const STEP_MS = 1000 / 30 // 33.33ms — a 30fps host frame interval
    let nowMs = 0
    let frames = 1
    let alpha = renderAndCaptureAlpha(ctx, renderer, camera, nowMs) // re-arms the ramp at nowMs=0
    expect(alpha, 'first draw of a fresh tile starts fully transparent').toBe(0)

    while (nowMs < 300) {
      nowMs += STEP_MS
      alpha = renderAndCaptureAlpha(ctx, renderer, camera, nowMs)
      frames++
    }
    // The wall clock reaches 300ms in ~9 more steps (~10 rendered frames total)
    // at 30fps — nowhere near the 18 frames the old 60fps-assumed ramp needed.
    expect(frames, 'reaches 300ms in ~10 frames at 30fps, not ~18').toBeLessThanOrEqual(11)
    expect(alpha, '30fps: the ramp is DONE once the wall clock hits 300ms').toBe(1)
  })

  it('120fps host: still mid-fade at 250ms (not already done, as at ~150ms pre-fix)', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    renderer.setRasterFadeDurationMs(300)
    const camera = flatCamera()
    seedTargets(renderer, camera)

    const STEP_MS = 1000 / 120 // 8.33ms — a 120fps host frame interval
    let nowMs = 0
    let alpha = renderAndCaptureAlpha(ctx, renderer, camera, nowMs) // re-arms the ramp at nowMs=0

    while (nowMs < 250) {
      nowMs += STEP_MS
      alpha = renderAndCaptureAlpha(ctx, renderer, camera, nowMs)
    }
    expect(
      alpha,
      '120fps: still mid-fade at 250ms — the 300ms duration is not up yet',
    ).toBeLessThan(1)

    // …and it DOES finish once the full 300ms duration has actually elapsed —
    // without this arm the assertion above would pass just as well against a
    // ramp that never completes at all.
    while (nowMs < 300) {
      nowMs += STEP_MS
      alpha = renderAndCaptureAlpha(ctx, renderer, camera, nowMs)
    }
    expect(alpha, '120fps: done once the wall clock actually reaches 300ms').toBe(1)
  })
})

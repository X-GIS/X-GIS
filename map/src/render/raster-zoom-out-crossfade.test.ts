// #1317 — raster zoom-OUT cross-fade. #1307 faded a freshly-shown tile IN over its
// cached PARENT (the zoom-in direction). Zooming back OUT (children → parent) SNAPPED:
// the parent's firstShownFrame was already stamped (fadeAlpha=1), and the departing
// children were not retained beneath it, so the higher-detail tiles popped out. This
// gate drives the REAL RasterRenderer.render() against the WebGPU stub (same harness as
// raster-globe-tile-selection.test.ts, intercepting the 48-byte per-tile uniform writes)
// and asserts, with no GPU:
//   1. a fading tile with cached CHILDREN draws them beneath it (detail retention) — the
//      child underlay adds draws over the no-children control;
//   2. with fade OFF the underlay never fires (byte-identical to the pre-fade path);
//   3. a tile RE-ENTERING the target set restamps firstShownFrame (re-fades instead of
//      snapping), while a tile continuing across frames keeps its ramp.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer, rasterCoverZoom, Camera } from '@xgis/map'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/geo'

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
type CacheEntry = { texture: unknown; lastUsedFrame: number; firstShownFrame: number }
const fakeTexture = { createView: () => ({}), destroy: () => undefined }

function makeRenderer(
  ctx: GPUContext,
  fadeMs: number,
): { renderer: RasterRenderer; cache: Map<string, CacheEntry> } {
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
  renderer.setRasterFadeDurationMs(fadeMs)
  const cache = (renderer as unknown as { tileCache: Map<string, CacheEntry> }).tileCache
  return { renderer, cache }
}

/** Replace queue.writeBuffer with a 48-byte-write (one per tile draw) counter. */
function interceptDraws(ctx: GPUContext): () => number {
  let n = 0
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (b: unknown, o: number, d: unknown) => void }
  }
  device.queue.writeBuffer = (buf: unknown): void => {
    if ((buf as { size?: number })?.size === 48) n++
  }
  return () => n
}

function renderPass(
  ctx: GPUContext,
  renderer: RasterRenderer,
  camera: Camera,
  projType: number,
): void {
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(encoder.beginRenderPass(), camera, projType, 0, 0, W, H, DPR)
}

const flatCamera = (): Camera => {
  const camera = new Camera(0, 0, 3)
  camera.projType = 0
  return camera
}

/** One flat-Mercator draw at zoom 3 with the target tiles (+ optionally their z+1
 *  children) pre-seeded; returns the intercepted tile-draw count. */
function drawCount(ctx: GPUContext, fadeMs: number, seedChildren: boolean): number {
  const camera = flatCamera()
  const { renderer, cache } = makeRenderer(ctx, fadeMs)
  const currentZ = rasterCoverZoom(camera.zoom, 256)
  const seed = (z: number, x: number, y: number): void => {
    cache.set(`${z}/${x}/${y}`, { texture: fakeTexture, lastUsedFrame: 0, firstShownFrame: 0 })
  }
  for (const t of visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)) {
    seed(t.z, t.x, t.y)
    if (seedChildren)
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++) seed(t.z + 1, t.x * 2 + dx, t.y * 2 + dy)
  }
  const count = interceptDraws(ctx)
  renderPass(ctx, renderer, camera, 0)
  return count()
}

describe('raster zoom-out cross-fade (#1317)', () => {
  it('a fading tile draws its cached children beneath it (zoom-out detail retention)', async () => {
    const ctx = await makeCtx()
    // Fresh renderer ⇒ every target enters the (empty) last-frame set ⇒ re-armed ⇒
    // fadeAlpha 0 ⇒ fading. With the children cached, each fading target also emits
    // them beneath, so the count exceeds the no-children control by the child draws.
    const withChildren = drawCount(ctx, 300, true)
    const withoutChildren = drawCount(ctx, 300, false)
    expect(withChildren).toBeGreaterThan(withoutChildren)
  })

  it('fade OFF ⇒ no underlay: cached children make no difference (pre-fade parity)', async () => {
    const ctx = await makeCtx()
    // fadeMs 0 ⇒ fadeFrames 0 ⇒ fadeAlpha 1 ⇒ the underlay branch never runs, so the
    // seeded children are inert — byte-identical draw count to the no-children path.
    const withChildren = drawCount(ctx, 0, true)
    const withoutChildren = drawCount(ctx, 0, false)
    expect(withChildren).toBe(withoutChildren)
  })

  it('re-arm: re-entering the target set restamps the ramp; a continuing tile keeps it', async () => {
    const camera = flatCamera()
    const currentZ = rasterCoverZoom(camera.zoom, 256)
    const targets = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)
    const first = targets[0]!
    const key = `${first.z}/${first.x}/${first.y}`
    const allKeys = targets.map((t) => `${t.z}/${t.x}/${t.y}`)

    // ── Re-entry: `first` was NOT a target last frame ⇒ re-arm to THIS frame. ──
    {
      const ctx = await makeCtx()
      const { renderer, cache } = makeRenderer(ctx, 300)
      for (const t of targets)
        cache.set(`${t.z}/${t.x}/${t.y}`, {
          texture: fakeTexture,
          lastUsedFrame: 0,
          firstShownFrame: 1,
        })
      const rw = renderer as unknown as { frameCount: number; _lastTargetKeys: Set<string> }
      rw.frameCount = 100
      rw._lastTargetKeys = new Set(allKeys.filter((k) => k !== key)) // everyone BUT `first`
      interceptDraws(ctx)
      renderPass(ctx, renderer, camera, 0)
      // Restamped to the current frame (101, not the stale 1) ⇒ fadeAlpha starts at 0
      // ⇒ it fades in on zoom-out rather than snapping to full opacity.
      expect((cache.get(key) as CacheEntry).firstShownFrame, 're-entering tile re-armed').toBe(
        rw.frameCount,
      )
      expect(rw.frameCount).toBe(101)
    }

    // ── Continuing: `first` WAS a target last frame ⇒ keep its ramp (no re-fade). ──
    {
      const ctx = await makeCtx()
      const { renderer, cache } = makeRenderer(ctx, 300)
      for (const t of targets)
        cache.set(`${t.z}/${t.x}/${t.y}`, {
          texture: fakeTexture,
          lastUsedFrame: 0,
          firstShownFrame: 1,
        })
      const rw = renderer as unknown as { frameCount: number; _lastTargetKeys: Set<string> }
      rw.frameCount = 100
      rw._lastTargetKeys = new Set(allKeys) // `first` WAS a target
      interceptDraws(ctx)
      renderPass(ctx, renderer, camera, 0)
      expect((cache.get(key) as CacheEntry).firstShownFrame, 'continuing tile keeps its ramp').toBe(
        1,
      )
    }
  })
})

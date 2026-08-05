// #1476 — a raster tile whose load resolved null was left in NEITHER the tile cache
// NOR the in-flight set, so the very next frame re-requested it: forever, at ~60 fps,
// with all 6 concurrency slots pinned by requests that can never succeed. That starves
// the parent-fallback fetches that would still have had something to draw.
//
// The identical defect was fixed for DEM tiles by tile-retry.ts (then named
// hillshade-tile-retry.ts); the raster arm never got the wiring. This gate drives the
// REAL RasterRenderer.render() against the WebGPU stub with a fetch that always 404s
// (the same stubbed-global pattern raster-loadtile-webgl2-cleanup.test.ts uses — a
// vi.mock('@xgis/data') binds too late under the eager projection setup) and asserts,
// with no GPU:
//   1. the storm is bounded — total requests over 40 frames stay far below one per
//      frame, where the pre-fix path issued ~6 per frame;
//   2. requests STOP once the attempt cap is spent, rather than resuming;
//   3. re-arming the source (a new URL template) clears the backoff, so the policy is
//      not a permanent blocklist.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer, Camera } from '@xgis/map'
import { MAX_TILE_ATTEMPTS } from './tile-retry'

let stub: StubInstallation
const priorFetch = globalThis.fetch

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
afterEach(() => {
  stub.uninstall()
  vi.restoreAllMocks()
  globalThis.fetch = priorFetch
})

const W = 1280
const H = 720
const DPR = 1

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: W, height: H } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

function flatCamera(): Camera {
  const camera = new Camera(0, 0, 3)
  camera.projType = 0
  return camera
}

function renderPass(ctx: GPUContext, renderer: RasterRenderer, camera: Camera): void {
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(wrapWebGpuPass(encoder.beginRenderPass()), camera, 0, 0, 0, W, H, DPR)
}

/** Every tile request 404s. Returns the per-URL attempt tally.
 *
 *  Counting PER URL, not per frame, is what makes this a real gate: the 6-slot
 *  concurrency cap staggers first attempts across many frames when more tiles are
 *  visible than fit, so a total-requests-per-frame bound would be satisfied by a
 *  storm that merely rotates between tiles. The invariant the fix actually
 *  establishes is per tile — no key is attempted more than `MAX_TILE_ATTEMPTS`
 *  times, whereas the pre-fix loop attempted each visible key EVERY frame. */
function install404Fetch(): Map<string, number> {
  const perUrl = new Map<string, number>()
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    perUrl.set(url, (perUrl.get(url) ?? 0) + 1)
    return new Response('', { status: 404 })
  }) as typeof fetch
  return perUrl
}

function maxAttempts(perUrl: Map<string, number>): number {
  let max = 0
  for (const n of perUrl.values()) if (n > max) max = n
  return max
}

/** Let the in-flight load chains settle: safeFetch → !response.ok → null → the
 *  renderer's `.then` records the failure and frees the slot. Several ticks because
 *  the chain awaits more than once. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

async function driveFrames(
  ctx: GPUContext,
  frames: number,
): Promise<{ perUrl: Map<string, number>; renderer: RasterRenderer }> {
  const camera = flatCamera()
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
  const perUrl = install404Fetch()
  for (let i = 0; i < frames; i++) {
    renderPass(ctx, renderer, camera)
    await settle()
  }
  return { perUrl, renderer }
}

describe('raster failed-tile backoff (#1476)', () => {
  it('no tile is attempted more than the cap, across 40 frames of total failure', async () => {
    const ctx = await makeCtx()
    const FRAMES = 40
    const { perUrl } = await driveFrames(ctx, FRAMES)

    // The fix bounds retries; it does not suppress the initial attempt.
    expect(perUrl.size).toBeGreaterThan(0)

    // THE gate. Pre-fix, a visible tile was re-requested on EVERY frame, so the worst
    // key's tally was ~FRAMES. The backoff caps it at MAX_TILE_ATTEMPTS (4), and only
    // the first two attempts (delay 30) even fit inside a 40-frame window.
    expect(maxAttempts(perUrl)).toBeLessThanOrEqual(MAX_TILE_ATTEMPTS)
    expect(maxAttempts(perUrl)).toBeLessThan(FRAMES)
  })

  it('a key that has spent its window does not retry inside the next backoff', async () => {
    // #1575 moved the backoff onto the WALL clock, so driving frames is no longer enough
    // to advance it — that is the point of the change: the frame counter froze whenever
    // the loop stopped, which is exactly when a failed tile needed it to keep running.
    // The clock is therefore driven explicitly here. `Date.now` rather than fake timers
    // because the load chain settles on real microtasks + setTimeout(0).
    const ctx = await makeCtx()
    const camera = flatCamera()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    const perUrl = install404Fetch()

    let clock = Date.now()
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      // Frame 0, then past the first 0.5 s backoff: attempts 1 and 2 land here.
      renderPass(ctx, renderer, camera)
      await settle()
      clock += 600
      for (let i = 0; i < 3; i++) {
        renderPass(ctx, renderer, camera)
        await settle()
      }
      const settled = new Map(perUrl)
      const witness = [...settled.entries()].sort((a, b) => b[1] - a[1])[0]!
      expect(witness[1], 'it really did retry once').toBeGreaterThanOrEqual(2)

      // The next delay is 2 s. Neither more frames NOR a shorter wait may re-request it.
      for (let i = 0; i < 30; i++) {
        renderPass(ctx, renderer, camera)
        await settle()
      }
      clock += 1_400
      renderPass(ctx, renderer, camera)
      await settle()
      expect(perUrl.get(witness[0]), 'still inside the 2 s window').toBe(witness[1])

      // …and it DOES come back once that window closes. Without this arm the assertion
      // above would pass just as well against a tile that had been abandoned outright.
      clock += 700
      renderPass(ctx, renderer, camera)
      await settle()
      expect(perUrl.get(witness[0]), 'the backoff elapses on wall time').toBe(witness[1] + 1)
    } finally {
      Date.now = realNow
    }
  })

  it('re-arming the source clears the backoff — not a permanent blocklist', async () => {
    const ctx = await makeCtx()
    const camera = flatCamera()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    install404Fetch()

    renderPass(ctx, renderer, camera)
    await settle()

    const failed = (renderer as unknown as { failedTiles: Map<string, unknown> }).failedTiles
    expect(failed.size).toBeGreaterThan(0)

    // A different template is a different coverage and says nothing about what failed.
    renderer.setUrlTemplate('https://other.example.com/{z}/{x}/{y}.png')
    expect(failed.size).toBe(0)

    // Same template again ⇒ no clear (the guard is `url !== this.urlTemplate`).
    renderPass(ctx, renderer, camera)
    await settle()
    const afterRefail = failed.size
    renderer.setUrlTemplate('https://other.example.com/{z}/{x}/{y}.png')
    expect(failed.size).toBe(afterRefail)
  })
})

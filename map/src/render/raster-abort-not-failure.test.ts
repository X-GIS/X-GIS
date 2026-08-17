// ═══ #1575 A — cancelling a tile must not poison its retry ledger ═══
//
// `RasterRenderer.render()` aborts every in-flight tile finer than the new zoom on a zoom
// change, and `loadTileTexture` resolves `null` for BOTH an abort and a 404 — the abort
// surfaces as a resolved null, never a rejection (`loadImageBitmap` returns null on
// `signal.aborted` and from its bare catch). So the `.then`'s `!texture` branch could not
// tell them apart and recorded a failure either way.
//
// `tile-retry.ts` states the set it is for in its own header — "a tile load that resolves
// null (404, network error, a decode/upload throw)" — and cancellation was never in it.
// `attempts` is cleared only by a successful load or a new URL template, and an aborted
// tile has neither, so four zoom oscillations across an LOD boundary on a slow network
// reached MAX_TILE_ATTEMPTS and permanently blocklisted exactly the tiles the user was
// looking at: a blurry parent fallback that never resolves.
//
// Driven through the real renderer against the WebGPU stub, mirroring
// raster-tile-retry-storm.test.ts — the fetch is held open so the abort provably lands
// while the load is still in flight, which is the only state the defect lives in.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer, Camera } from '@xgis/map'

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

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: W, height: H } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

function cameraAt(zoom: number): Camera {
  const camera = new Camera(0, 0, zoom)
  camera.projType = 0
  return camera
}

function renderPass(ctx: GPUContext, renderer: RasterRenderer, camera: Camera): void {
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(wrapWebGpuPass(encoder.beginRenderPass()), camera, 0, 0, 0, W, H, 0, 1)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** A fetch that never resolves until the request's own signal aborts — so every tile the
 *  renderer requests is still IN FLIGHT when the zoom change cancels it. */
function installHangingFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as typeof fetch
}

/** The ledger keeps its backoff state private on purpose; its `size` is the observable
 *  that answers this test — an ABORT must leave NO entry behind at all. */
function ledgerSize(renderer: RasterRenderer): number {
  return renderer.failedTiles.size
}

describe('#1575 A — an aborted tile load is not a failure', () => {
  it('four zoom oscillations record no attempts at all', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    installHangingFetch()

    // Each crossing requests fine tiles, then the next render at a coarser zoom aborts
    // every one of them — the exact user gesture: pinching back and forth over an LOD
    // boundary while the network is slow.
    for (let i = 0; i < 4; i++) {
      renderPass(ctx, renderer, cameraAt(6))
      await settle()
      renderPass(ctx, renderer, cameraAt(3))
      await settle()
    }

    // Before the fix every aborted key landed here with `attempts` climbing toward
    // MAX_TILE_ATTEMPTS, and at 4 the tile was never requested again for the life of the
    // source — exactly the tiles the user was oscillating over.
    expect(ledgerSize(renderer), 'cancellation must leave the ledger untouched').toBe(0)
  })

  it('CONTROL — a real 404 on the same path still records a failure', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
    globalThis.fetch = (async (): Promise<Response> =>
      new Response('', { status: 404 })) as typeof fetch

    renderPass(ctx, renderer, cameraAt(3))
    await settle()

    // Without this arm, a guard that suppressed EVERY failure record would pass the case
    // above while silently re-opening the per-frame retry storm #1476 closed.
    expect(ledgerSize(renderer), 'a 404 is still a failure').toBeGreaterThan(0)
  })
})

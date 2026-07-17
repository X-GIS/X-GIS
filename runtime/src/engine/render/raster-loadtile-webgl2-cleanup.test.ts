// R4 (#1153 P2) — the WebGL2 raster tile decode (RasterRenderer.loadTileTexture)
// had no try/catch: a createTexture throw on a lost context REJECTED the load
// chain (wedging its loadingTiles slot forever — all 6 eventually pin, raster
// stops + the loop never idles) AND leaked the decoded ImageBitmap. The fix wraps
// createTexture + copyExternalImage, closing the bitmap + destroying any
// half-created texture and RESOLVING null (the WebGPU contract) so the chain's
// `.then` clears the slot instead of the chain rejecting.
//
// Reached via the (private) loadTileTexture on a stub-built RasterRenderer whose
// rhi is swapped for a webgl2 fake; loadImageBitmap resolves through a stubbed
// global fetch + createImageBitmap (the SSRF-integration-test pattern — a
// vi.mock('@xgis/data') binds too late under the eager projection setup).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { RasterRenderer } from '@xgis/map'
import type { RhiTexture } from '@xgis/engine'

let stub: StubInstallation
const priorFetch = globalThis.fetch
const priorCIB = (globalThis as { createImageBitmap?: unknown }).createImageBitmap

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
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
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = priorCIB
})

async function makeRasterRenderer(): Promise<RasterRenderer> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  const ctx = await initGPU(canvas)
  return new RasterRenderer(ctx)
}

function installFakeBitmap(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  globalThis.fetch = (async () => new Response('tile', { status: 200 })) as typeof fetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 4,
    height: 4,
    close,
  })
  return { close }
}

// Swap in a webgl2 fake rhi so loadTileTexture takes the WebGL2 branch.
function useWebgl2Rhi(
  rr: RasterRenderer,
  rhi: {
    createTexture: () => RhiTexture
    copyExternalImage: () => void
    destroyTexture: () => void
  },
): void {
  ;(rr as unknown as { rhi: unknown }).rhi = { backend: 'webgl2', ...rhi }
}

const URL = 'https://example.com/tile.png' // public → passes the SSRF literal check

function loadTile(rr: RasterRenderer): Promise<GPUTexture | RhiTexture | null> {
  return (
    rr as unknown as {
      loadTileTexture: (u: string, s: AbortSignal) => Promise<GPUTexture | RhiTexture | null>
    }
  ).loadTileTexture(URL, new AbortController().signal)
}

describe('RasterRenderer.loadTileTexture webgl2 failure cleanup (#1153 P2 R4)', () => {
  it('RESOLVES null (never rejects) on a createTexture throw, and closes the bitmap', async () => {
    const rr = await makeRasterRenderer()
    const { close } = installFakeBitmap()
    const destroyTexture = vi.fn()
    useWebgl2Rhi(rr, {
      createTexture: () => {
        throw new Error('createTexture on lost webgl2 context')
      },
      copyExternalImage: () => {},
      destroyTexture,
    })

    // Fail-before: the base webgl2 branch REJECTS here, so the production chain's
    // `.then(t => loadingTiles.delete(key))` never runs → slot wedged forever.
    await expect(loadTile(rr)).resolves.toBeNull()
    expect(close).toHaveBeenCalledTimes(1) // bitmap released (fail-before: leaked)
    expect(destroyTexture).not.toHaveBeenCalled() // nothing was created
  })

  it('destroys the half-created texture when copyExternalImage throws after createTexture', async () => {
    const rr = await makeRasterRenderer()
    const { close } = installFakeBitmap()
    const fakeTex = { __tex: true } as unknown as RhiTexture
    const destroyTexture = vi.fn()
    useWebgl2Rhi(rr, {
      createTexture: () => fakeTex,
      copyExternalImage: () => {
        throw new Error('copyExternalImage on lost webgl2 context')
      },
      destroyTexture,
    })

    await expect(loadTile(rr)).resolves.toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyTexture).toHaveBeenCalledTimes(1) // half-created texture freed
    expect(destroyTexture).toHaveBeenCalledWith(fakeTex)
  })

  it('happy path returns the texture and closes the bitmap once (no destroy)', async () => {
    const rr = await makeRasterRenderer()
    const { close } = installFakeBitmap()
    const fakeTex = { __tex: true } as unknown as RhiTexture
    const destroyTexture = vi.fn()
    useWebgl2Rhi(rr, { createTexture: () => fakeTex, copyExternalImage: () => {}, destroyTexture })

    await expect(loadTile(rr)).resolves.toBe(fakeTex)
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyTexture).not.toHaveBeenCalled()
  })
})

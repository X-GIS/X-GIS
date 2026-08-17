// #1623 — HillshadeRenderer.loadTileTexture's WebGPU arm used to bypass the RHI
// entirely via the raw-device `loadImageTexture` (data/src/tile-select.ts, now
// deleted), which resolved the bare native GPUTexture straight off
// `device.createTexture` — the raw-arm shape `raster-cache-budget.ts`'s
// `destroyTileTexture` used to have to discriminate against (#1607). This pins the
// fix: on the DEFAULT (WebGPU) backend, loadTileTexture now resolves the SAME
// `{ native }` RHI wrapper `rhi.createTexture` produces everywhere else
// (rhi-webgpu.ts:477) — not the native texture directly.
//
// It also carries the #1153 P2 R4 failure contract for this path (bitmap closed, any
// half-created handle destroyed, null RESOLVED rather than the chain rejecting), which
// data/src/tile-select-load-cleanup.test.ts held over `loadImageTexture` until the fork
// was deleted.
//
// Reached via the (private) loadTileTexture on a HillshadeRenderer built over the
// real WebGPU stub (installWebGPUStub + initGPU, the raster-loadtile-webgl2-cleanup
// idiom); loadImageBitmap resolves through a stubbed global fetch + createImageBitmap
// (the SSRF-integration-test pattern — a vi.mock('@xgis/data') binds too late under
// the eager projection setup).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { HillshadeRenderer } from '@xgis/map'
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

async function makeHillshadeRenderer(): Promise<HillshadeRenderer> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  const ctx = await initGPU(canvas)
  return new HillshadeRenderer(ctx)
}

function installFakeBitmap(width: number, height: number): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  globalThis.fetch = (async () => new Response('dem-tile', { status: 200 })) as typeof fetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width,
    height,
    close,
  })
  return { close }
}

/** Swap the renderer's RHI for a fake so the #1153 P2 R4 failure contract is reachable
 *  (the stub device never throws). Only the three methods loadTileTexture touches. */
function useFakeRhi(
  hr: HillshadeRenderer,
  rhi: {
    createTexture: () => RhiTexture
    copyExternalImage: () => void
    destroyTexture: () => void
  },
): void {
  ;(hr as unknown as { rhi: unknown }).rhi = rhi
}

const URL = 'https://example.com/dem.png' // public → passes the SSRF literal check

type Loaded = { texture: { native?: unknown; destroy?: unknown }; bytes: number } | null

function loadTile(hr: HillshadeRenderer): Promise<Loaded> {
  return (
    hr as unknown as { loadTileTexture: (u: string, s: AbortSignal) => Promise<Loaded> }
  ).loadTileTexture(URL, new AbortController().signal)
}

describe('HillshadeRenderer.loadTileTexture routes the default WebGPU backend through the RHI (#1623)', () => {
  it('resolves the RHI wrapper shape ({ native }), un-mipped — not the raw GPUTexture arm', async () => {
    const hr = await makeHillshadeRenderer()
    installFakeBitmap(4, 4)

    const loaded = await loadTile(hr)

    expect(loaded).not.toBeNull()
    // Fail-before: the raw-device arm resolved the native GPUTexture itself, which
    // carries a top-level `.destroy()` (the stub's `makeTexture()`). The RHI wrap
    // (rhi-webgpu.ts:477) boxes it as `{ native }` instead — no top-level `.destroy`.
    expect(loaded!.texture).not.toHaveProperty('destroy')
    expect(loaded!.texture).toHaveProperty('native')
    // mip-scope-invariant — a DEM tile is DATA, never mipped: base level only.
    expect(loaded!.bytes).toBe(4 * 4 * 4)
  })

  // The #1153 P2 R4 failure contract used to be covered on this path by
  // data/src/tile-select-load-cleanup.test.ts (over `loadImageTexture`, deleted with the
  // fork). It survives here, against the RHI arm that replaced it: a createTexture throw
  // must RESOLVE null — never reject, or the chain's `.then` never clears the
  // loadingTiles slot and the DEM source wedges — and must release the decoded bitmap.
  it('RESOLVES null (never rejects) on a createTexture throw, closing the bitmap (#1153 P2 R4)', async () => {
    const hr = await makeHillshadeRenderer()
    const { close } = installFakeBitmap(4, 4)
    const destroyTexture = vi.fn()
    useFakeRhi(hr, {
      createTexture: () => {
        throw new Error('createTexture on lost context')
      },
      copyExternalImage: () => {},
      destroyTexture,
    })

    await expect(loadTile(hr)).resolves.toBeNull()
    expect(close).toHaveBeenCalledTimes(1) // bitmap released, not leaked
    expect(destroyTexture).not.toHaveBeenCalled() // nothing was created
  })

  it('destroys the half-created texture when copyExternalImage throws after createTexture', async () => {
    const hr = await makeHillshadeRenderer()
    const { close } = installFakeBitmap(4, 4)
    const fakeTex = { __tex: true } as unknown as RhiTexture
    const destroyTexture = vi.fn()
    useFakeRhi(hr, {
      createTexture: () => fakeTex,
      copyExternalImage: () => {
        throw new Error('copyExternalImage on lost context')
      },
      destroyTexture,
    })

    await expect(loadTile(hr)).resolves.toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyTexture).toHaveBeenCalledTimes(1) // half-created texture freed
    expect(destroyTexture).toHaveBeenCalledWith(fakeTex)
  })
})

// ═══ #1579 C — the vector-drape bake cache never got the byte cap ═══
//
// `vector-drape-renderer.ts` bounded its baked-fill texture cache with a flat
// `MAX_CACHED_BAKES = 256`, whose own comment claimed parity with the raster tile cache —
// true when written, false since #1352/#1350 moved that family to a viewport-classed byte
// ceiling (96 MiB mobile / 384 MiB desktop, `maxRasterCachedBytes`). Every bake is exactly
// 512²  RGBA8 (a uniform entry size, unlike raster/hillshade's publisher-controlled
// dimensions), so a COUNT cap is already an exact byte cap — it only needed to be routed
// through the SAME viewport-aware authority via `maxCachedEntriesFor`, instead of a second,
// flat, always-desktop-sized copy of the split.
//
// This is a BEHAVIOURAL gate (not source-text): it constructs a real `VectorDrapeRenderer`
// against the WebGPU stub, injects synthetic baked entries through the private surface
// (TS `private` is not a runtime barrier — the point is to reach the real beginFrame loop),
// and proves eviction settles at the viewport's byte cap, not at the old flat count.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import type { RhiTexture } from '@xgis/engine'
import { VectorDrapeRenderer } from './vector-drape-renderer'
import { maxCachedEntriesFor, maxRasterCachedBytes } from './raster-cache-budget'

const BAKE_PX = 512
const BAKE_BYTES = BAKE_PX * BAKE_PX * 4

function stubViewport(width: number, pointer: 'coarse' | 'fine'): void {
  vi.stubGlobal('window', { innerWidth: width })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse') ? pointer === 'coarse' : pointer === 'fine',
    media: q,
  }))
}

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
afterEach(() => {
  stub.uninstall()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** The private cache surface `beginFrame()` reads. */
interface DrapePrivates {
  baked: Map<string, { tex: RhiTexture; lastCall: number }>
  beginFrame(): void
}
const privatesOf = (r: VectorDrapeRenderer): DrapePrivates => r as unknown as DrapePrivates

function fillBaked(r: DrapePrivates, n: number): void {
  for (let i = 0; i < n; i++) {
    r.baked.set(`tile/${i}`, { tex: {} as RhiTexture, lastCall: i })
  }
}

describe('#1579 C — VectorDrapeRenderer.beginFrame caps the bake cache by BYTES', () => {
  it('on a mobile-class viewport, eviction settles at the byte cap, not the old flat 256', async () => {
    stubViewport(390, 'coarse')
    const mobileCap = maxCachedEntriesFor(BAKE_BYTES)
    // Premise: the old flat cap (256) would have kept every one of these resident on a
    // budget this small — the defect the fix closes.
    expect(mobileCap, 'premise: mobile budget caps well under the old flat 256').toBeLessThan(256)

    const ctx = await makeCtx()
    const r = privatesOf(new VectorDrapeRenderer(ctx.rhi, ctx.format, 1))
    fillBaked(r, 256)

    r.beginFrame()

    expect(r.baked.size, 'resident bakes must drain to the viewport byte cap').toBeLessThanOrEqual(
      mobileCap,
    )
  })

  it('on a desktop viewport, the cap tracks maxRasterCachedBytes, not a hardcoded number', async () => {
    stubViewport(1440, 'fine')
    const desktopCap = maxCachedEntriesFor(BAKE_BYTES)
    expect(desktopCap).toBe(Math.floor(maxRasterCachedBytes() / BAKE_BYTES))

    const ctx = await makeCtx()
    const r = privatesOf(new VectorDrapeRenderer(ctx.rhi, ctx.format, 1))
    fillBaked(r, desktopCap + 50)

    r.beginFrame()

    expect(r.baked.size).toBeLessThanOrEqual(desktopCap)
  })

  it('CONTROL — under the cap, beginFrame evicts nothing (a cache that always drains to 0 would pass the caps above vacuously)', async () => {
    stubViewport(1440, 'fine')
    const ctx = await makeCtx()
    const r = privatesOf(new VectorDrapeRenderer(ctx.rhi, ctx.format, 1))
    fillBaked(r, 10)

    r.beginFrame()

    expect(r.baked.size, 'a cache well under budget must not evict').toBe(10)
  })
})

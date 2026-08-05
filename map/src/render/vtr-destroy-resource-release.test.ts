// R1 (#1153 P2) — VectorTileRenderer.destroy() must release the StagingBufferPool
// and the BundleCache it owns. Before the fix destroy() dropped every per-tile /
// arena buffer but NEVER called stagingPool.dispose() (the tiered pool, up to
// ~16 MB, leaked on every setSourceData swap until GC — the iOS staircase) and
// never cleared the bundle cache's GC-owned GPURenderBundle refs.
//
// Driven through the WebGPU stub (initGPU + real VTR construction, like
// renderers-stub-construction.test.ts) with prototype spies on the two release
// keystones. Fail-before: destroy() never invokes either, so both spies stay at 0.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, StagingBufferPool, BundleCache } from '@xgis/rhi-webgpu'
import { VectorTileRenderer } from '@xgis/map'

let stub: StubInstallation

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
})

async function makeCtx(): Promise<Awaited<ReturnType<typeof initGPU>>> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas)
}

describe('VectorTileRenderer.destroy() releases owned GPU pools (#1153 P2 R1)', () => {
  it('calls stagingPool.dispose() and bundleCache.invalidateAll() exactly once', async () => {
    const disposeSpy = vi.spyOn(StagingBufferPool.prototype, 'dispose')
    const invalidateAllSpy = vi.spyOn(BundleCache.prototype, 'invalidateAll')
    try {
      const ctx = await makeCtx()
      const vtr = new VectorTileRenderer(ctx)
      // Ignore any construction / render-time calls that predate destroy().
      disposeSpy.mockClear()
      invalidateAllSpy.mockClear()

      expect(() => vtr.destroy()).not.toThrow()

      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(invalidateAllSpy).toHaveBeenCalledTimes(1)
    } finally {
      disposeSpy.mockRestore()
      invalidateAllSpy.mockRestore()
    }
  })
})

// ═══ #1567 — the __xgisFillRhi globalThis slot must not outlive the map ═════
//
// The #717 dual-instance workaround mirrors the last fill state onto a
// `globalThis` slot so a split-module draw-side VTR can recover it. The mirror
// was guarded by `if (state)`, so it was write-once-latching: `setFillRhi(null)`
// could not clear it, `destroy()` never touched it, and repo-wide there is no
// other writer or deleter. A destroyed map's entire fill Material/pipeline
// registry therefore stayed strongly reachable for the page lifetime — the
// ordinary SPA mount/unmount never gets that memory back — and
// `recordFillDraw`'s LABEL fallback could resolve a dead device's Materials.
//
// `rhi.destroy()` frees the GPU bytes. This is about the JS wrapper graph.
const slot = (): unknown => (globalThis as { __xgisFillRhi?: unknown }).__xgisFillRhi

describe('#1567 VectorTileRenderer does not pin fill state on globalThis', () => {
  beforeEach(() => {
    delete (globalThis as { __xgisFillRhi?: unknown }).__xgisFillRhi
  })

  it('destroy() releases the slot it owns', async () => {
    const ctx = await makeCtx()
    const vtr = new VectorTileRenderer(ctx)
    const state = { perStyle: new Map(), perStyleExtrude: new Map() }
    vtr.setFillRhi(state as never)
    expect(slot(), 'the #717 mirror still populates in the normal path').toBe(state)

    vtr.destroy()
    expect(slot(), 'the destroyed map must not pin its fill registry').toBeFalsy()
  })

  it('setFillRhi(null) clears the slot rather than latching the last non-null', async () => {
    const ctx = await makeCtx()
    const vtr = new VectorTileRenderer(ctx)
    vtr.setFillRhi({ perStyle: new Map(), perStyleExtrude: new Map() } as never)
    vtr.setFillRhi(null)
    expect(slot(), 'the mirror must track the state exactly, including null').toBeFalsy()
    vtr.destroy()
  })

  it('destroy() clears BY IDENTITY — a second live map keeps its own slot', async () => {
    // This is the #717 case the slot exists for: two VTR instances, the slot
    // holding whichever wrote last. Tearing down the FIRST one must not steal the
    // second's recovery path, so the clear is conditional on identity.
    const ctxA = await makeCtx()
    const ctxB = await makeCtx()
    const a = new VectorTileRenderer(ctxA)
    const b = new VectorTileRenderer(ctxB)
    const stateA = { perStyle: new Map(), perStyleExtrude: new Map() }
    const stateB = { perStyle: new Map(), perStyleExtrude: new Map() }
    a.setFillRhi(stateA as never)
    b.setFillRhi(stateB as never)
    expect(slot()).toBe(stateB)

    a.destroy()
    expect(slot(), 'A must not clear B-s mirror').toBe(stateB)
    b.destroy()
    expect(slot()).toBeFalsy()
  })
})

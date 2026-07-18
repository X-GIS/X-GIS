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
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
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

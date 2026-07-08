// raster-resampling sampler wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-resampling
// (linear default / nearest) is marked `supported`, but its runtime wiring was
// never verified behaviorally. Unlike the colour-adjust props this is NOT a
// uniform value — it selects which immutable GPUSampler the per-tile bind groups
// bind. A broken data path (setResampling stops swapping the active sampler)
// would ship silently: a `raster-resampling: nearest` style would keep getting
// linear filtering (blurred DEM staircase / pixel-art).
//
// The runtime contract (raster-renderer.ts:202-205): the orchestrator calls
// RasterRenderer.setResampling(true) for `nearest`; the renderer points its
// active `sampler` field at the pre-built `nearestSampler` (else `linearSampler`).
// That field is exactly what createBindGroup binds, so its identity IS the
// GPU-visible resampling choice. Default (un-authored) = linear.
//
// Non-vacuous: linearSampler and nearestSampler are distinct objects, so the
// assertion can only hold if setResampling actually re-points `sampler`.
//
// Fail-before: in raster-renderer.ts:205 change
//   `this.sampler = nearest ? this.nearestSampler : this.linearSampler`
// to `this.sampler = this.linearSampler` and the nearest-case assertion fails —
// the wire that makes raster-resampling:nearest reach the GPU is gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer } from '@xgis/map'

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

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// Post-P1.4 (RHI Material seam): the immutable linear/nearest samplers + the per-tile bind
// groups now live in the RasterDraper, which selects the sampler per draw from the `nearest`
// arg. The renderer's role is reduced to the `_nearest` flag it forwards to draper.draw()
// (raster-renderer.ts: `this.ensureRasterDraper().draw(..., this._nearest, …)`). So the
// GPU-free contract here is that setResampling drives that flag; the sampler-object selection
// is the RasterDraper's concern (covered by the draper + the real-GPU resampling parity).
/** Read the renderer's resampling flag (forwarded to RasterDraper.draw). */
function nearestFlag(r: RasterRenderer): boolean {
  return (r as unknown as { _nearest: boolean })._nearest
}

describe('raster-resampling wiring (GPU-free)', () => {
  it('defaults to linear (nearest = false)', async () => {
    const r = new RasterRenderer(await makeCtx())
    expect(nearestFlag(r)).toBe(false)
  })

  it('setResampling(true) selects nearest', async () => {
    const r = new RasterRenderer(await makeCtx())
    r.setResampling(true)
    expect(nearestFlag(r)).toBe(true)
  })

  it('setResampling(false) restores linear', async () => {
    const r = new RasterRenderer(await makeCtx())
    r.setResampling(true)
    r.setResampling(false)
    expect(nearestFlag(r)).toBe(false)
  })
})

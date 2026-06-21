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
import { initGPU, type GPUContext } from '../gpu/gpu'
import { RasterRenderer } from './raster-renderer'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** Read the renderer's private sampler-trio identities. */
function samplers(r: RasterRenderer): { active: unknown; linear: unknown; nearest: unknown } {
  const p = r as unknown as { sampler: unknown; linearSampler: unknown; nearestSampler: unknown }
  return { active: p.sampler, linear: p.linearSampler, nearest: p.nearestSampler }
}

describe('raster-resampling sampler wiring (GPU-free)', () => {
  it('default active sampler is the linear sampler', async () => {
    const ctx = await makeCtx()
    const r = new RasterRenderer(ctx)
    const s = samplers(r)
    // Guard: the two samplers must be distinct objects for the test to mean
    // anything (else the identity assertions below would be vacuous).
    expect(s.linear).not.toBe(s.nearest)
    expect(s.active).toBe(s.linear)
  })

  it('setResampling(true) re-points the active sampler at the nearest sampler', async () => {
    const ctx = await makeCtx()
    const r = new RasterRenderer(ctx)
    r.setResampling(true)
    const s = samplers(r)
    // Break `sampler = nearest ? nearestSampler : linearSampler` → stays linear → fails.
    expect(s.active).toBe(s.nearest)
  })

  it('setResampling(false) restores the linear sampler', async () => {
    const ctx = await makeCtx()
    const r = new RasterRenderer(ctx)
    r.setResampling(true)
    r.setResampling(false)
    const s = samplers(r)
    expect(s.active).toBe(s.linear)
  })
})

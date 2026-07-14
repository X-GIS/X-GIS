import { describe, it, expect } from 'vitest'
import { WebGl2Device } from '@xgis/rhi-webgl2'
import type { RhiCaps } from '@xgis/rhi'
import type { FrameContext } from './frame-context'

// ═══ FrameContext RHI seam reachability (#1046 F1) ═══
//
// F1 threads the backend device onto the frame value-object so a pass or seam can ask
// `ctx.rhi.caps.*` instead of branching on `backend` (doc §3-F1). This gate proves the
// seam is REACHABLE two ways:
//   • at tsc time — `capsThroughSeam` compiles ONLY if FrameContext carries a required
//     `rhi: RhiDevice` whose `.caps` is an RhiCaps (and REQUIRED, so the render-loop
//     build site is forced to populate it — the wiring proof is the type, not a mock);
//   • at runtime — a real backend device placed as `ctx.rhi` reads its caps back
//     through the seam accessor.
// F1 is seam-only: NO pass reads caps yet, so nothing here asserts a consumer branch.

/** Compiles iff FrameContext.rhi is an RhiDevice whose `.caps` is an RhiCaps. */
const capsThroughSeam = (ctx: FrameContext): RhiCaps => ctx.rhi.caps

/** Minimal fake GL — the device ctor reads sampler enums once + getSupportedExtensions. */
function fakeGl(): WebGL2RenderingContext {
  return {
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    getSupportedExtensions: () => [],
  } as unknown as WebGL2RenderingContext
}

describe('FrameContext carries the RhiDevice so caps reach the frame path (#1046 F1)', () => {
  it('reads a real device caps record through ctx.rhi', () => {
    const device = new WebGl2Device(fakeGl())
    // Only `rhi` is populated — the seam is about the device handle, not a full frame.
    const ctx = { rhi: device } as unknown as FrameContext
    const caps = capsThroughSeam(ctx)
    expect(ctx.rhi.backend).toBe('webgl2')
    expect(caps.compute).toBe('fragment-emulated')
    expect(caps.maxSampleCount).toBe(1)
  })
})

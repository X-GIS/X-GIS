// ═══ wireFrameColour clamps sampleCount to the device cap (#1046 F4 Inc-E1) ═══
//
// QUALITY.msaa is a HOST policy (4 on desktop default); maxSampleCount is a
// DEVICE capability (WebGPU 4, WebGl2Device 1 — its screen pass has no MSAA
// resolve). Unclamped, a flipped WebGL2 chain frame would compute
// useResolve=true, attach a resolveTarget, and die at the backend's
// fail-closed screen pass ("no MSAA resolve target", rhi-webgl2) on frame
// one — flip blocker #2. The clamp is the raster-renderer precedent
// (Math.min(getSampleCount(), caps.maxSampleCount)) applied at the ONE site
// that seeds the frame's sampleCount. On WebGPU (cap 4) it is the identity.

import { describe, it, expect, afterEach } from 'vitest'
import { QUALITY } from '@xgis/engine'
import { wireFrameColour, type FrameContext } from './frame-context'

const origMsaa = QUALITY.msaa
afterEach(() => {
  QUALITY.msaa = origMsaa
})

function makeCtx(maxSampleCount: number) {
  const ensureScs: number[] = []
  const result = {
    useResolve: false,
    colorView: {},
    sceneScaled: false,
    sceneResolveView: {},
    colorViewScreen: {},
    sceneColorSampleView: null,
  }
  const ctx = {
    rhi: { caps: { maxSampleCount } },
    rt: {
      ensure: (...a: unknown[]) => {
        ensureScs.push(a[4] as number)
        return result
      },
      stencilView: {},
    },
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
  } as unknown as FrameContext
  return { ctx, ensureScs }
}

describe('wireFrameColour — sampleCount ≤ caps.maxSampleCount (#1046 F4 Inc-E1)', () => {
  it('QUALITY.msaa=4 on a maxSampleCount=1 device ⇒ the frame runs single-sample', () => {
    QUALITY.msaa = 4
    const { ctx, ensureScs } = makeCtx(1)
    wireFrameColour(ctx, {} as never)
    // Both the context scalar every pass reads AND the sc handed to ensure
    // (which sizes msaa/stencil and decides useResolve) must be the clamp.
    expect(ctx.sampleCount).toBe(1)
    expect(ensureScs).toEqual([1])
  })

  it('a cap of 4 leaves the desktop default untouched (identity on WebGPU)', () => {
    QUALITY.msaa = 4
    const { ctx, ensureScs } = makeCtx(4)
    wireFrameColour(ctx, {} as never)
    expect(ctx.sampleCount).toBe(4)
    expect(ensureScs).toEqual([4])
  })
})

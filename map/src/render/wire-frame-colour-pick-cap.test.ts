// ═══ wireFrameColour clamps the PICK target to the device, like the sample count (#1046 Inc-F) ═══
//
// `RenderTargets.ensure` allocates a scene-sized rg32uint pick attachment when the
// host asks for picking, and the opaque pass attaches it to every sub-pass. On a
// device whose PRESENTABLE pass cannot carry MRT — WebGl2Device: FBO 0 takes one
// colour attachment — that attachment made the chain's screen pass fail-loud every
// frame ("got 2 colour attachments"), and the texture it allocated was never read
// there anyway: the WebGL2 pick strategy is the ON-DEMAND offscreen pass
// (RenderLoop.pickViaRhi), which renders its own MRT. So the ask is host POLICY and
// the answer is a DEVICE cap — the same shape as the sample-count clamp two lines
// above it, and the same authority: decided once at the wiring site, not per pass.
//
// Fail-before: with `isPickEnabled()` passed straight through, the webgl2 case below
// receives `pick === true`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { wireFrameColour } from './frame-context'
import { QUALITY } from '@xgis/engine'
import type { FrameContext } from './frame-context'

const origPicking = QUALITY.picking
afterEach(() => {
  QUALITY.picking = origPicking
})

/** Capture the `pickEnabled` argument `wireFrameColour` hands RenderTargets.ensure. */
function pickAskedFor(presentablePassMrt: boolean): boolean {
  const ensure = vi.fn((..._args: unknown[]) => ({
    useResolve: false,
    colorView: {},
    sceneResolveView: undefined,
    colorViewScreen: {},
    sceneColorSampleView: undefined,
  }))
  const ctx = {
    rhi: { caps: { maxSampleCount: 1, presentablePassMrt } },
    rt: { ensure, stencilView: {} },
    scene: { w: 800, h: 600 },
    screen: { w: 800, h: 600 },
  } as unknown as FrameContext
  wireFrameColour(ctx, {} as never)
  expect(ensure).toHaveBeenCalledTimes(1)
  return ensure.mock.calls[0]![5] as boolean
}

describe('wireFrameColour — the in-frame pick target is host policy CLAMPED by the device (#1046 Inc-F)', () => {
  it('picking on + presentable pass carries MRT (WebGPU) ⇒ asks for the pick target', () => {
    QUALITY.picking = true
    expect(pickAskedFor(true)).toBe(true)
  })

  it('picking on + presentable pass CANNOT MRT (WebGl2Device) ⇒ does NOT ask', () => {
    QUALITY.picking = true
    expect(pickAskedFor(false)).toBe(false)
  })

  it('picking off ⇒ never asks, whatever the device answers', () => {
    QUALITY.picking = false
    expect(pickAskedFor(true)).toBe(false)
    expect(pickAskedFor(false)).toBe(false)
  })
})

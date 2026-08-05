// ═══ wireFrameColour withholds ?debug=overdraw from an immediate device (#1046 Inc-F2d) ═══
//
// `?debug=overdraw` routes EVERY scene pass's colour target to an r16float
// accumulator (render-targets.ts: `colorView = debugOverdraw ? overdrawView : …`,
// and unscaled `colorViewScreen === colorView`, so the overlays go there too).
// Only the trailing compose writes the swapchain — and that compose is still raw
// WebGPU (P6): it unwraps a native pass encoder and calls `ctx.device`.
//
// On an immediate device that compose threw every frame, and map.ts halts the
// render loop after three consecutive frame failures. The tempting fix — decline
// inside the compose — stops the crash and produces a WORSE artifact: the
// accumulator routing is still in force, so no pass writes the swapchain and the
// frame is BLANK. That was the first attempt at this fix, and it is why this test
// lives at the wiring site instead of at the pass.
//
// Gating the ROUTING is what actually reproduces the forced-WebGL2 twin: the twin
// calls `rhi.beginScreenPass` and binds FBO 0 directly, never consulting
// RenderTargets, so `?debug=overdraw` there renders an ordinary map on a
// transparent clear. With overdraw withheld here, no accumulator is allocated,
// the colour target resolves normally, the scene passes draw to the swapchain,
// and the compose declines through its own `!overdrawAccumTexture` guard — no
// capability check of its own required.
//
// THE FLAG IS MOCKED, and that is load-bearing rather than convenience.
// `DEBUG_OVERDRAW` is a module-level const, false under vitest, so `DEBUG_OVERDRAW
// && executionModel !== 'immediate'` and a bare `DEBUG_OVERDRAW` are BOTH false
// on every device — the first version of this file asserted against the real flag
// and passed with the gate reverted. Forcing it true is what makes the two arms
// answer differently and the assertion mean anything.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../debug-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../debug-flags')>()),
  DEBUG_OVERDRAW: true,
}))

import { wireFrameColour } from './frame-context'
import type { FrameContext } from './frame-context'

/** The `debugOverdraw` argument `wireFrameColour` hands RenderTargets.ensure. */
function overdrawAskedFor(executionModel: 'immediate' | 'deferred'): boolean {
  const ensure = vi.fn((..._args: unknown[]) => ({
    useResolve: false,
    colorView: {},
    sceneResolveView: undefined,
    colorViewScreen: {},
    sceneColorSampleView: undefined,
  }))
  const ctx = {
    rhi: { caps: { maxSampleCount: 1, presentablePassMrt: true, executionModel } },
    rt: { ensure, stencilView: {} },
    scene: { w: 800, h: 600 },
    screen: { w: 800, h: 600 },
  } as unknown as FrameContext
  wireFrameColour(ctx, {} as never)
  expect(ensure).toHaveBeenCalledTimes(1)
  return ensure.mock.calls[0]![6] as boolean
}

describe('wireFrameColour — overdraw target routing is device-gated (#1046 Inc-F2d)', () => {
  it('an IMMEDIATE device is never handed overdraw, even with the flag ON', () => {
    expect(
      overdrawAskedFor('immediate'),
      'the overdraw accumulator was routed on an immediate device: the compose that is the ' +
        'only writer of the swapchain there is raw WebGPU, so the frame either throws ' +
        '(no gate) or goes blank (gate in the wrong place)',
    ).toBe(false)
  })

  it('a DEFERRED device still gets it — a clamp, not an off-switch', () => {
    // The anti-vacuity arm. A blanket `false` satisfies the case above while
    // silently disabling ?debug=overdraw on WebGPU, the one backend it works on.
    // The two arms differ in exactly ONE input, so together they pin the gate.
    expect(
      overdrawAskedFor('deferred'),
      'WebGPU lost the overdraw heatmap — this is a capability clamp, not a feature kill',
    ).toBe(true)
  })
})

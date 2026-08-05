// ═══ The chain draws the analytic checker when there is no raster source (#1046 Inc-F2d) ═══
//
// `?debug=checker` paints a z0 world tile through the SAME RasterDraper a real
// raster source uses — a genuine raster draw with NO network. Its only caller in
// the entire repo was the forced-WebGL2 twin (`render-loop.ts`, the `else if
// (DEBUG_RHI_CHECKER)` arm beside `hasSource()`); the chain called
// `rasterRenderer.render` unconditionally and that early-returns without a
// urlTemplate. So on the chain the checker painted nothing.
//
// That is invisible until the twin is deleted, and then it is not:
// `playground/e2e/_webgl2-live-render-gate.spec.ts` boots
// `?forcegl2=1&e2e=1&debug=checker` and asserts `checker texels > 60%` with NO
// arm branch — the US-003/US-004 live-render gate goes red on deletion day.
//
// The checker is ported rather than retired BECAUSE it needs no network. The
// gates that fetch real tiles already fail on runners without egress (that is
// what makes `_demotiles-labels-gl2-gate` unmeasurable here), so re-fixturing
// the live-render gate onto a real source would trade a deterministic gate for
// a flaky one.
//
// DEBUG_RHI_CHECKER is a module-level const read at import time and false under
// vitest, so the flag module is mocked — without that both arms below would be
// unreachable and every assertion would pass vacuously.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../debug-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../debug-flags')>()),
  DEBUG_RHI_CHECKER: true,
}))

import { opaquePass } from './opaque-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

function run(hasSource: boolean) {
  const captured: unknown[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = { desc, end: () => undefined }
    captured.push(p)
    return p
  })
  const ctx = {
    rhi: { __rhiDevice: true, caps: { executionModel: 'deferred' } },
    rhiEncoder: { beginRenderPass },
    rhiScreenView: { __screen: true },
    rhiColorView: { __color: true },
    rhiStencilView: { __stencil: true },
    rhiSceneResolveView: { __sceneResolve: true },
    rhiColorViewScreen: { __color: true },
    passScope: (_l: string, fn: () => void) => fn(),
    useResolve: false,
    rt: { pickTexture: undefined, pickView: null },
    projection: makeProjectionToken(0, 0, 0),
    camera: { __camera: true },
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 999, h: 998, dpr: 9 },
    _elapsedMs: 0,
  } as unknown as FrameContext
  const render = vi.fn()
  const renderRhiChecker = vi.fn()
  const host = {
    gpuTimer: undefined,
    _rasterShow: undefined,
    _elapsedMs: 0,
    camera: {
      globeMode: false,
      zoom: 3,
      centerX: 0,
      centerY: 0,
      getViewForProjection: () => ({ matrix: new Float32Array(16), logDepthFc: 1 }),
    },
    pointRenderer: {},
    rasterRenderer: {
      setOpacity: () => undefined,
      setColorAdjust: () => undefined,
      setResampling: () => undefined,
      hasSource: () => hasSource,
      render,
      renderRhiChecker,
    },
    underOccluder: undefined,
    coverageRenderer: { hasCoverage: () => false, render: () => undefined },
    flowRenderer: null,
    renderer: {
      renderToPass: () => undefined,
      renderGraticuleOverlay: () => undefined,
    },
  }
  const scene = {
    opaqueGroups: [{ shows: [{ show: {}, fillPhase: 'both', draw: () => undefined }] }],
    resolveOwner: 'none',
    hasPoints: false,
    hasOit: false,
  } as unknown as SceneView
  opaquePass.execute(ctx, scene, host as never)
  return { render, renderRhiChecker, captured }
}

describe('opaque pass — the checker arm (#1046 Inc-F2d)', () => {
  it('NO raster source + ?debug=checker ⇒ the analytic checker is drawn', () => {
    const { render, renderRhiChecker, captured } = run(false)
    expect(
      renderRhiChecker,
      'the chain drew no checker with ?debug=checker and no raster source — the twin was this ' +
        "call's only caller, so deleting the twin leaves the live-render gate with a blank frame",
    ).toHaveBeenCalledTimes(1)
    expect(render, 'the real raster draw has no source to draw').not.toHaveBeenCalled()
    // Drawn INTO the frame's sub-pass, not some pass of its own, and at SCENE
    // geometry like every other draw in this pass (screen is deliberately a
    // different size in this harness, so a screen/scene mix-up cannot pass).
    const [rhiArg, passArg, , , , , w, h, dpr] = renderRhiChecker.mock.calls[0]!
    expect(rhiArg, 'the RHI device by identity, not a re-wrap').toEqual({
      __rhiDevice: true,
      caps: { executionModel: 'deferred' },
    })
    expect(passArg, 'the checker rides the opaque sub-pass').toBe(captured[0])
    expect([w, h, dpr], 'scene geometry, never screen').toEqual([800, 600, 1])
  })

  it('a raster source present ⇒ the real draw wins and the checker stays out', () => {
    // The other direction, so the arm cannot pass vacuously: the checker is a
    // FALLBACK, and a checker drawn over live tiles would be a worse bug than
    // the one this fixes.
    const { render, renderRhiChecker } = run(true)
    expect(render).toHaveBeenCalledTimes(1)
    expect(renderRhiChecker, 'the checker must never cover a real source').not.toHaveBeenCalled()
  })
})

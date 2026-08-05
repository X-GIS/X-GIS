// ═══ The heatmap pass fail-closes without float-blend targets (#1046 Inc-F2c) ═══
//
// The heatmap's density accumulation renders to an r16float target with additive
// blend, which needs EXT_color_buffer_float + EXT_float_blend on WebGL2. That is
// a CAPABILITY (`rhi.caps.floatBlendTargets`), feature-detected per device — a
// desktop WebGL2 context commonly answers true, a weaker one answers false.
//
// HeatmapRenderer states the contract at its own entry: "The caller has already
// gated on rhi.caps.floatBlendTargets." The forced-WebGL2 twin (deleted, #1046
// Inc-F3a) was such a caller (`hasLayers() && rhi.caps.floatBlendTargets`). The
// chain's caller — this pass — was NOT: it gated on `scene.hasHeatmap` and
// `hasLayers()` only, so on a device without the extensions the chain walked
// straight into the renderer that assumes its caller checked. Deleting the twin
// without this fix would have removed the only fail-close in the product.
//
// The gate lives in `execute`, not `shouldRun`: `shouldRun(scene)` receives no
// FrameContext and therefore cannot see the device.

import { describe, it, expect, vi } from 'vitest'
import { heatmapPass } from './heatmap-pass'
import { makeProjectionToken } from '../projection-token'
import type { SceneView } from '../scene-view'
import type { FrameContext } from '../frame-context'
import type { HeatmapPassHost } from './pass'

function run(floatBlendTargets: boolean) {
  const renderChainRhi = vi.fn()
  const host = {
    heatmapRenderer: { hasLayers: () => true, renderChainRhi },
    heatmapTargets: {},
  } as unknown as HeatmapPassHost
  const ctx = {
    rhi: { caps: { floatBlendTargets } },
    rhiEncoder: { __enc: true },
    rhiScreenView: { __screen: true },
    rhiColorView: { __color: true },
    rhiStencilView: { __stencil: true },
    rhiSceneResolveView: { __sceneResolve: true },
    rhiColorViewScreen: { __colorScreen: true },
    projection: makeProjectionToken(0, 0, 0),
    camera: {},
    scene: { w: 800, h: 600, dpr: 1 },
    passScope: (_l: string, fn: () => void) => fn(),
  } as unknown as FrameContext
  const scene = { hasHeatmap: true } as unknown as SceneView
  if (heatmapPass.shouldRun(scene)) heatmapPass.execute(ctx, scene, host as never)
  return renderChainRhi
}

describe('heatmap pass — float-blend capability fail-close (#1046 Inc-F2c)', () => {
  it('device CAN blend into float targets ⇒ the 3-pass pipeline runs', () => {
    expect(run(true)).toHaveBeenCalledTimes(1)
  })

  it('device CANNOT ⇒ the pass declines, and the renderer is never entered', () => {
    expect(
      run(false),
      'renderChainRhi was entered on a device without EXT_color_buffer_float / ' +
        'EXT_float_blend — the renderer documents that its CALLER performs this gate. ' +
        'Without it the r16float accumulation target is unsupported on that device.',
    ).not.toHaveBeenCalled()
  })
})

// ═══ Heatmap pass → RHI seam wiring (#1046 F3b Inc-2c) ═══
//
// The heatmap pass's whole per-layer accum → blur → compose loop lives behind
// HeatmapRenderer.renderChainRhi (shared drapers with the twin's renderRhi,
// #1060). This gate pins the SEAM: execute() must hand renderChainRhi exactly
// the frame's RHI handles (reference identity — a re-wrap or a re-derive is the
// double-wrap class 34d4695 killed), the SCENE geometry (it rasterises the
// world; target-role-partition polices the source, this pins the values), and
// must fail loud on twin-frame null bridges instead of encoding a wrong frame.
//
// GPU-free: stub FrameContext + host, no device. Fail-before: on the native
// heatmap-pass body (pre-Inc-2c) case 1 is RED — renderChainRhi is never
// called; the assert names the seam, not an incidental crash.

import { describe, it, expect, vi } from 'vitest'
import { heatmapPass } from './heatmap-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

const SCENE = { hasHeatmap: true } as unknown as SceneView

function harness() {
  const enc = { __rhiEncoder: true }
  const screenView = { __rhiScreenView: true }
  const camera = { __camera: true }
  const targets = { __heatmapTargets: true }
  const ctx = {
    // The density accumulation blends into a float target, so the pass reads
    // `ctx.rhi.caps` (#1046 Inc-F2c). `rhi` is a REQUIRED FrameContext field
    // that this stub simply did not model — the `as unknown as FrameContext`
    // cast is what let it compile without one — so omitting it does not
    // fail-close here, it throws `Cannot read properties of undefined
    // (reading 'caps')` and masks the error this file actually asserts on.
    rhi: { caps: { floatBlendTargets: true } },
    rhiEncoder: enc,
    rhiScreenView: screenView,
    rhiColorView: { __rhiColorView: true },
    rhiSceneResolveView: { __sceneResolve: true },
    rhiColorViewScreen: { __colorScreen: true },
    rhiStencilView: { __rhiStencilView: true },
    camera,
    projection: makeProjectionToken(3, 10, 20),
    // Distinct scene vs screen values: the pass is a SCENE pass, so the args
    // below must be the 640/480/2 triple — 999/998/9 appearing instead means
    // the role read regressed (the half-pixel-nobody-notices class).
    scene: { w: 640, h: 480, dpr: 2 },
    screen: { w: 999, h: 998, dpr: 9 },
    passScope: (_label: string, fn: () => void) => fn(),
  } as unknown as FrameContext
  const renderChainRhi = vi.fn()
  const host = {
    heatmapRenderer: { hasLayers: () => true, renderChainRhi },
    heatmapTargets: targets,
  }
  return { ctx, host, enc, screenView, camera, targets, renderChainRhi }
}

describe('heatmap pass — RHI seam wiring (#1046 F3b)', () => {
  it('hands renderChainRhi the frame RHI handles by IDENTITY + the scene geometry', () => {
    const h = harness()
    heatmapPass.execute(h.ctx, SCENE, h.host as never)
    expect(h.renderChainRhi).toHaveBeenCalledTimes(1)
    const args = h.renderChainRhi.mock.calls[0]
    expect(args[0]).toBe(h.enc)
    expect(args[1]).toBe(h.screenView)
    expect(args[2]).toBe(h.targets)
    expect(args[3]).toBe(h.camera)
    expect(args.slice(4)).toEqual([3, 10, 20, 640, 480, 2])
  })

  it('no layers ⇒ no seam call (the hasLayers gate is preserved)', () => {
    const h = harness()
    ;(h.host.heatmapRenderer as { hasLayers: () => boolean }).hasLayers = () => false
    heatmapPass.execute(h.ctx, SCENE, h.host as never)
    expect(h.renderChainRhi).not.toHaveBeenCalled()
  })

  it('twin-frame null bridges ⇒ throws naming the pass, encodes nothing', () => {
    const h = harness()
    ;(h.ctx as { rhiEncoder: unknown }).rhiEncoder = null
    expect(() => heatmapPass.execute(h.ctx, SCENE, h.host as never)).toThrow(/heatmap/)
    expect(h.renderChainRhi).not.toHaveBeenCalled()
  })
})

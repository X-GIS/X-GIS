// ═══ Opaque pass → RHI seam wiring (#1046 F3b Inc-2d) ═══
//
// The opaque bucket originates its sub-passes through the RHI frame shell:
// requireRhiFrame hands the pass the frame's RHI encoder + view bridges BY
// IDENTITY (a re-wrap or re-derive is the 34d4695 double-wrap class), the
// gpuTimer rides the Inc-1 beginTimedPass/markRhi seam instead of a raw
// timestampWrites field, and the descriptor topology the native block
// declared survives byte-for-byte: first-sub-pass clears depth + pick,
// later sub-passes load; resolveTarget only on the last sub-pass when the
// scene assigns resolveOwner 'opaque'; depth persists when points/oit
// follow. Raw-shell escape (null bridges) fails loud naming the pass.
//
// GPU-free: stub FrameContext + host. Fail-before: on the native body every
// case below is RED — the encoder handle is ctx.encoder (native), no RHI
// descriptor is captured, and the raw-shell case encodes instead of throwing.

import { describe, it, expect, vi } from 'vitest'
import { QUALITY } from '@xgis/engine'
import { opaquePass } from './opaque-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

interface CapturedPass {
  desc: Record<string, unknown>
  ended: boolean
}

function harness(opts: { pick?: boolean; resolveOwner?: string; groups?: number } = {}) {
  const captured: CapturedPass[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = {
      desc,
      ended: false,
      end() {
        p.ended = true
      },
    }
    captured.push(p as unknown as CapturedPass)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  const screenView = { __rhiScreenView: true }
  const colorView = { __rhiColorView: true }
  const stencilView = { __rhiStencilView: true }
  // #1429 INC-2 — the resolve moved to the scene-resolve bridge. A DISTINCT
  // token (not screenView) so a pass reverting to the screen view — the bug
  // class a scaled frame exposes — fails the pin.
  const sceneResolveView = { __rhiSceneResolveView: true }
  const pickView = opts.pick ? { __rhiPickView: true } : null
  const ctx = {
    rhiEncoder: enc,
    rhiScreenView: screenView,
    rhiColorView: colorView,
    rhiStencilView: stencilView,
    rhiSceneResolveView: sceneResolveView,
    rhiColorViewScreen: colorView,
    passScope: (_label: string, fn: () => void) => fn(),
    useResolve: opts.resolveOwner !== undefined,
    // pick rides RT-side accessors (adapter-owned textures; RHI-native since
    // Inc-D), not a FrameContext bridge — the bridges stay the per-frame trio.
    rt: { pickTexture: opts.pick ? {} : undefined, pickView },
    projection: makeProjectionToken(0, 0, 0),
    camera: { __camera: true },
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 999, h: 998, dpr: 9 },
    _elapsedMs: 0,
  } as unknown as FrameContext
  const order: string[] = []
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
      render: (pass: unknown) => order.push(`raster:${pass === captured[0] ? 'rhi0' : '?'}`),
    },
    underOccluder: undefined,
    coverageRenderer: { hasCoverage: () => false, render: () => order.push('coverage') },
    flowRenderer: null,
    renderer: {
      uniformBuffer: {},
      renderToPass: () => order.push('legacy'),
      renderGraticuleOverlay: () => order.push('graticule'),
    },
  }
  const groups = Array.from({ length: opts.groups ?? 1 }, (_v, gi) => ({
    shows: [
      {
        show: {},
        fillPhase: 'both',
        draw: (pass: unknown) =>
          order.push(`show${gi}:${captured.includes(pass as never) ? 'rhi' : '?'}`),
      },
    ],
  }))
  const scene = {
    opaqueGroups: groups,
    resolveOwner: opts.resolveOwner ?? 'none',
    hasPoints: false,
    hasOit: false,
  } as unknown as SceneView
  return {
    ctx,
    host,
    scene,
    captured,
    order,
    beginRenderPass,
    sceneResolveView,
    stencilView,
    pickView,
  }
}

describe('opaque pass — RHI seam wiring (#1046 F3b Inc-2d)', () => {
  it('originates every sub-pass on the frame RHI encoder with the bridge views by IDENTITY', () => {
    const h = harness({ groups: 2 })
    opaquePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).toHaveBeenCalledTimes(2)
    for (const p of h.captured) {
      const colors = p.desc.colorAttachments as { view: unknown }[]
      expect(colors[0].view).toBe((h.ctx as { rhiColorView: unknown }).rhiColorView)
      const ds = p.desc.depthStencilAttachment as { view: unknown }
      expect(ds.view).toBe(h.stencilView)
      expect(p.ended).toBe(true)
    }
    // Every show + renderer received the RHI sub-pass handle, not a re-wrap.
    expect(h.order).toContain('raster:rhi0')
    expect(h.order.filter((o) => o.startsWith('show')).every((o) => o.endsWith(':rhi'))).toBe(true)
  })

  it('first sub-pass clears depth, later sub-passes load; resolve only on the last when owned', () => {
    const h = harness({ groups: 3, resolveOwner: 'opaque' })
    opaquePass.execute(h.ctx, h.scene, h.host as never)
    const ds = h.captured.map((p) => p.desc.depthStencilAttachment as { depthLoadOp: string })
    expect(ds[0].depthLoadOp).toBe('clear')
    expect(ds[1].depthLoadOp).toBe('load')
    expect(ds[2].depthLoadOp).toBe('load')
    const resolves = h.captured.map(
      (p) => (p.desc.colorAttachments as { resolveTarget?: unknown }[])[0].resolveTarget,
    )
    expect(resolves[0]).toBeUndefined()
    expect(resolves[1]).toBeUndefined()
    expect(resolves[2]).toBe(h.sceneResolveView)
  })

  it('pick armed ⇒ the second colour attachment is rt.pickView (clear then load)', () => {
    const h = harness({ groups: 2, pick: true })
    const origPicking = QUALITY.picking
    QUALITY.picking = true
    try {
      opaquePass.execute(h.ctx, h.scene, h.host as never)
    } finally {
      QUALITY.picking = origPicking
    }
    const picks = h.captured.map(
      (p) => (p.desc.colorAttachments as { view: unknown }[])[1]?.view ?? null,
    )
    expect(picks[0]).toBe(h.pickView)
    expect(picks[1]).toBe(h.pickView)
    const ops = h.captured.map((p) => (p.desc.colorAttachments as { loadOp: string }[])[1]?.loadOp)
    expect(ops[0]).toBe('clear')
    expect(ops[1]).toBe('load')
  })

  it('depth persists into a following points/oit consumer, discards when last (persistDepth)', () => {
    const alone = harness({ groups: 1 })
    opaquePass.execute(alone.ctx, alone.scene, alone.host as never)
    const dsAlone = alone.captured[0].desc.depthStencilAttachment as { depthStoreOp: string }
    expect(dsAlone.depthStoreOp).toBe('discard')
    const withPoints = harness({ groups: 1 })
    ;(withPoints.scene as { hasPoints: boolean }).hasPoints = true
    opaquePass.execute(withPoints.ctx, withPoints.scene, withPoints.host as never)
    const dsPts = withPoints.captured[0].desc.depthStencilAttachment as { depthStoreOp: string }
    expect(dsPts.depthStoreOp).toBe('store')
  })

  it('twin-frame null bridges ⇒ throws naming the pass, encodes nothing', () => {
    const h = harness()
    ;(h.ctx as { rhiEncoder: unknown }).rhiEncoder = null
    expect(() => opaquePass.execute(h.ctx, h.scene, h.host as never)).toThrow(/opaque/)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })
})

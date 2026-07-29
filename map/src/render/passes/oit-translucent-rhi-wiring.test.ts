// ═══ OIT + translucent passes → RHI seam wiring (#1046 F3b Inc-2d) ═══
//
// Both buckets originate through the RHI frame shell. OIT: the fill pass
// targets the RT-side RHI accessors (rt.oitAccumViewRhi / rt.oitRevealageViewRhi
// — adapter-owned textures, mirroring rt.pickViewRhi) with the opaque depth
// loaded; the compose pass draws onto the colour bridge with the conditional
// resolve. Translucent: the offscreen stroke pass comes from the narrowed
// lineRenderer.beginTranslucentPass(RhiCommandEncoder) and the composite from
// lineRenderer.composite(RhiRenderPass). Every ShowDrawFn invocation receives
// the RHI handle BY IDENTITY (the 34d4695 double-wrap class). Raw-shell
// escape fails loud naming the pass.
//
// Fail-before: on the native bodies every case is RED — passes begin on
// ctx.encoder, cs.draw receives native handles, and raw-shell encodes
// instead of throwing.

import { describe, it, expect, vi } from 'vitest'
import { oitPass } from './oit-pass'
import { translucentPass } from './translucent-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

function rhiFrame() {
  const captured: { desc: Record<string, unknown>; ended: boolean }[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = {
      desc,
      ended: false,
      end() {
        p.ended = true
      },
    }
    captured.push(p)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  // #1429 INC-2 — distinct scene-resolve token (see the opaque harness note).
  const sceneResolveView = { __sceneResolve: true }
  const ctx = {
    rhiEncoder: enc,
    rhiScreenView: { __screen: true },
    rhiColorView: { __color: true },
    rhiStencilView: { __stencil: true },
    rhiSceneResolveView: sceneResolveView,
    rhiColorViewScreen: { __colorScreen: true },
    passScope: (_l: string, fn: () => void) => fn(),
    useResolve: true,
    projection: makeProjectionToken(0, 0, 0),
    camera: {},
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 999, h: 998, dpr: 9 },
    sampleCount: 4,
  } as unknown as FrameContext
  return { ctx, captured, beginRenderPass, enc, sceneResolveView }
}

describe('oit pass — RHI seam wiring (#1046 F3b Inc-2d)', () => {
  function oitHarness() {
    const f = rhiFrame()
    const oitAccumViewRhi = { __oitAccum: true }
    const oitRevealageViewRhi = { __oitReveal: true }
    ;(f.ctx as { rt: unknown }).rt = {
      ensureOit: vi.fn(),
      oitAccumViewRhi,
      oitRevealageViewRhi,
    }
    const drawn: unknown[] = []
    const scene = {
      hasOit: true,
      hasTranslucent: false,
      hasPoints: false,
      resolveOwner: 'composite',
      oit: [{ draw: (pass: unknown) => drawn.push(pass) }],
    } as unknown as SceneView
    const composeCalls: unknown[] = []
    const host = {
      renderer: {
        uniformBuffer: {},
        drawOitCompose: (pass: unknown) => composeCalls.push(pass),
      },
      ctx: {},
    }
    return { ...f, scene, host, drawn, composeCalls, oitAccumViewRhi, oitRevealageViewRhi }
  }

  it('fill pass targets the RT RHI accessors, loads opaque depth, hands cs.draw the RHI handle', () => {
    const h = oitHarness()
    oitPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.captured.length).toBeGreaterThanOrEqual(2)
    const fill = h.captured[0].desc
    const colors = fill.colorAttachments as {
      view: unknown
      loadOp: string
      storeOp: string
      clearValue?: unknown
    }[]
    expect(colors[0].view).toBe(h.oitAccumViewRhi)
    expect(colors[1].view).toBe(h.oitRevealageViewRhi)
    expect(colors[0].loadOp).toBe('clear')
    // The McGuire-Bavoil clears: accum to 0, revealage to 1 (review F4 pin).
    expect(colors[0].clearValue).toEqual([0, 0, 0, 0])
    expect(colors[1].clearValue).toEqual([1, 0, 0, 0])
    expect(colors[0].storeOp).toBe('store')
    const ds = fill.depthStencilAttachment as {
      view: unknown
      depthLoadOp: string
      depthStoreOp: string
      stencilLoadOp: string
      stencilStoreOp: string
    }
    expect(ds.view).toBe((h.ctx as { rhiStencilView: unknown }).rhiStencilView)
    expect(ds.depthLoadOp).toBe('load')
    expect(ds.depthStoreOp).toBe('discard')
    expect(ds.stencilLoadOp).toBe('load')
    expect(ds.stencilStoreOp).toBe('discard')
    expect(h.drawn).toHaveLength(1)
    expect(h.drawn[0]).toBe(h.captured[0])
  })

  it('compose pass draws onto the colour bridge with the conditional resolve, via the renderer entry', () => {
    const h = oitHarness()
    oitPass.execute(h.ctx, h.scene, h.host as never)
    const comp = h.captured[1].desc
    const colors = comp.colorAttachments as { view: unknown; resolveTarget?: unknown }[]
    expect(colors[0].view).toBe((h.ctx as { rhiColorView: unknown }).rhiColorView)
    expect(colors[0].resolveTarget).toBe(h.sceneResolveView)
    expect(h.composeCalls).toHaveLength(1)
    expect(h.composeCalls[0]).toBe(h.captured[1])
  })

  it('twin-frame null bridges ⇒ throws naming the pass', () => {
    const h = oitHarness()
    ;(h.ctx as { rhiEncoder: unknown }).rhiEncoder = null
    expect(() => oitPass.execute(h.ctx, h.scene, h.host as never)).toThrow(/oit/)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })
})

describe('translucent pass — RHI seam wiring (#1046 F3b Inc-2d)', () => {
  function trHarness() {
    const f = rhiFrame()
    const offPass = {
      __offPass: true,
      end: vi.fn(),
    }
    const drawn: unknown[] = []
    const composites: { pass: unknown; opacity: number }[] = []
    const beginTranslucentPass = vi.fn((enc: unknown) => {
      void enc
      return offPass
    })
    const host = {
      renderer: { uniformBuffer: {} },
      lineRenderer: {
        beginTranslucentPass,
        composite: (pass: unknown, opacity: number) => composites.push({ pass, opacity }),
      },
    }
    const scene = {
      hasTranslucent: true,
      hasPoints: false,
      hasOit: false,
      resolveOwner: 'composite',
      translucent: [{ draw: (pass: unknown) => drawn.push(pass), resolvedShow: { opacity: 0.42 } }],
    } as unknown as SceneView
    return { ...f, host, scene, drawn, composites, offPass, beginTranslucentPass }
  }

  it('offscreen pass comes from the narrowed lineRenderer entry ON the RHI encoder; composite gets the RHI comp pass', () => {
    const h = trHarness()
    translucentPass.execute(h.ctx, h.scene, h.host as never)
    // The line renderer is handed the frame's RHI encoder BY IDENTITY.
    expect(h.beginTranslucentPass).toHaveBeenCalledTimes(1)
    expect(h.beginTranslucentPass.mock.calls[0][0]).toBe(h.enc)
    // Offscreen sized from the SCENE geometry (decoy screen 999×998 must not
    // appear) — the world rasterises at scene size (review F4 pin).
    expect(h.beginTranslucentPass.mock.calls[0].slice(1)).toEqual([800, 600])
    // The stroke draw runs on the offscreen pass the renderer returned.
    expect(h.drawn).toEqual([h.offPass])
    expect(h.offPass.end).toHaveBeenCalledTimes(1)
    // The composite pass originates on the RHI encoder, targets the colour
    // bridge with the last-show resolve, and reaches composite() by identity.
    expect(h.captured).toHaveLength(1)
    const comp = h.captured[0].desc
    const colors = comp.colorAttachments as { view: unknown; resolveTarget?: unknown }[]
    expect(colors[0].view).toBe((h.ctx as { rhiColorView: unknown }).rhiColorView)
    expect(colors[0].resolveTarget).toBe(h.sceneResolveView)
    expect(h.composites).toEqual([{ pass: h.captured[0], opacity: 0.42 }])
  })

  it('twin-frame null bridges ⇒ throws naming the pass', () => {
    const h = trHarness()
    ;(h.ctx as { rhiEncoder: unknown }).rhiEncoder = null
    expect(() => translucentPass.execute(h.ctx, h.scene, h.host as never)).toThrow(/translucent/)
    expect(h.beginTranslucentPass).not.toHaveBeenCalled()
  })
})

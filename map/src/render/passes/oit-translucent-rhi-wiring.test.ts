// ═══ Shell + translucent passes → RHI seam wiring (#1046 F3b Inc-2d) ═══
//
// Both buckets originate through the RHI frame shell. SHELL (#1253, the pass
// that occupies the `oit` slot): the fill pass targets the RT-side shell
// accessors with the opaque DEPTH loaded and its own stencil cleared, and the
// compose pass draws onto the colour bridge with the conditional resolve.
// Translucent: the offscreen stroke pass comes from the narrowed
// lineRenderer.beginTranslucentPass(RhiCommandEncoder) and the composite from
// lineRenderer.composite(RhiRenderPass). Every ShowDrawFn invocation receives
// the RHI handle BY IDENTITY (the 34d4695 double-wrap class). Raw-shell
// escape fails loud naming the pass.
//
// Fail-before: on the native bodies every case is RED — passes begin on
// ctx.encoder, cs.draw receives native handles, and raw-shell encodes
// instead of throwing. The shell cases were additionally RED before #1253:
// the pass attached the accum/revealage MRT pair and composed through
// `renderer.drawOitCompose`.

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
      // The shell composite runs a real Material through executeItems, so the
      // captured pass must accept the draw verbs (no-ops — this file gates
      // TOPOLOGY, not the draw's contents).
      setPipeline() {},
      setBindGroup() {},
      draw() {},
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

/** A device just deep enough for the shell compositor's Material: it emits real
 *  WGSL (`caps.shaderLanguage`), creates the two bind-group layouts, one
 *  pipeline, the pooled uniform buffer and the bind groups. Nothing is
 *  inspected — the point is that the pass builds a REAL Material through the
 *  RHI seam rather than a stub, so a descriptor the seam rejects surfaces here. */
function shellRhi() {
  return {
    caps: { shaderLanguage: 'wgsl', executionModel: 'deferred' },
    backend: 'webgpu',
    createSampler: () => ({ __sampler: true }),
    createBindGroupLayout: () => ({ __bgl: true }),
    createBindGroup: () => ({ __bg: true }),
    createPipeline: (d: { label?: string }) => ({ native: { label: d.label } }),
    createBuffer: () => ({ __buf: true }),
    writeBuffer: () => {},
    destroyPipeline: () => {},
    destroyBuffer: () => {},
    destroySampler: () => {},
  }
}

describe('extrude-shell pass — RHI seam wiring (#1046 F3b Inc-2d, #1253)', () => {
  function oitHarness(scenePatch: Record<string, unknown> = {}) {
    const f = rhiFrame()
    const extrudeShellView = { __shell: true }
    const extrudeShellResolveView = { __shellResolve: true }
    const extrudeShellSampleView = extrudeShellResolveView
    const ensureExtrudeShell = vi.fn()
    ;(f.ctx as { rt: unknown }).rt = {
      ensureExtrudeShell,
      extrudeShellView,
      extrudeShellResolveView,
      extrudeShellSampleView,
      // Picking off in this harness: the pick attachment is the opaque pass's
      // shape and has its own gate; keeping it null pins the no-pick topology.
      pickTexture: null,
      pickView: null,
    }
    const drawn: { pass: unknown; phase: unknown; translucentBucket: unknown }[] = []
    const scene = {
      hasOit: true,
      hasTranslucent: false,
      hasPoints: false,
      resolveOwner: 'oit',
      oit: [
        {
          draw: (pass: unknown, _c: unknown, _p: unknown, phase: unknown, tb: unknown) =>
            drawn.push({ pass, phase, translucentBucket: tb }),
          show: { shaderVariant: null },
          resolvedShow: { opacity: 0.6, fill: [1, 0, 0, 1] },
        },
      ],
      ...scenePatch,
    } as unknown as SceneView
    const host = { renderer: {}, ctx: { rhi: shellRhi(), format: 'bgra8unorm' } }
    return { ...f, scene, host, drawn, ensureExtrudeShell, extrudeShellView, extrudeShellSampleView }
  }

  it('shell pass targets the shell RT, LOADs opaque depth, clears its own stencil', () => {
    const h = oitHarness()
    oitPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.ensureExtrudeShell).toHaveBeenCalledWith(800, 600, 4)
    expect(h.captured.length).toBeGreaterThanOrEqual(2)
    const fill = h.captured[0].desc
    const colors = fill.colorAttachments as {
      view: unknown
      resolveTarget?: unknown
      loadOp: string
      storeOp: string
      clearValue?: unknown
    }[]
    // ONE colour attachment (picking off): the shell target, cleared to fully
    // transparent so an uncovered pixel contributes nothing to the composite.
    expect(colors).toHaveLength(1)
    expect(colors[0].view).toBe(h.extrudeShellView)
    expect(colors[0].loadOp).toBe('clear')
    expect(colors[0].clearValue).toEqual([0, 0, 0, 0])
    expect(colors[0].storeOp).toBe('store')
    // msaa 4 in this frame ⇒ the shell resolves into its sampleable twin, which
    // is what the composite then reads (a multisampled view has no RHI layout).
    expect(colors[0].resolveTarget).toBe(h.extrudeShellSampleView)
    const ds = fill.depthStencilAttachment as {
      view: unknown
      depthLoadOp: string
      depthStoreOp: string
      stencilLoadOp: string
      stencilStoreOp: string
    }
    // The whole point of the shell: it depth-tests against the OPAQUE pass's
    // depth (so translucent walls stay occluded) and WRITES, which is what
    // resolves the front-most surface across tiles.
    expect(ds.view).toBe((h.ctx as { rhiStencilView: unknown }).rhiStencilView)
    expect(ds.depthLoadOp).toBe('load')
    expect(ds.depthStoreOp).toBe('discard')
    expect(ds.stencilLoadOp).toBe('clear')
    expect(ds.stencilStoreOp).toBe('discard')
    // The draw runs on the shell pass, in the shell phase, with the depth-
    // bearing (non-translucent-bucket) flag.
    expect(h.drawn).toHaveLength(1)
    expect(h.drawn[0].pass).toBe(h.captured[0])
    expect(h.drawn[0].phase).toBe('oit-fill')
    expect(h.drawn[0].translucentBucket).toBe(false)
  })

  it('depth is STORED when a later consumer needs it (the points bucket)', () => {
    const h = oitHarness({ hasPoints: true, resolveOwner: 'points' })
    oitPass.execute(h.ctx, h.scene, h.host as never)
    const ds = h.captured[0].desc.depthStencilAttachment as { depthStoreOp: string }
    expect(ds.depthStoreOp).toBe('store')
  })

  it('compose pass draws onto the colour bridge with the conditional resolve', () => {
    const h = oitHarness()
    oitPass.execute(h.ctx, h.scene, h.host as never)
    const comp = h.captured[1].desc
    const colors = comp.colorAttachments as { view: unknown; resolveTarget?: unknown }[]
    expect(colors[0].view).toBe((h.ctx as { rhiColorView: unknown }).rhiColorView)
    // resolveOwner 'oit' — the shell composite is this frame's LAST colour
    // writer, so it owns the resolve. Without the owner rung the opaque pass
    // would have resolved before this draw and the extrusions would vanish.
    expect(colors[0].resolveTarget).toBe(h.sceneResolveView)
  })

  it('a frame whose resolve belongs to a LATER pass composites without resolving', () => {
    const h = oitHarness({ hasPoints: true, resolveOwner: 'points' })
    oitPass.execute(h.ctx, h.scene, h.host as never)
    const colors = h.captured[1].desc.colorAttachments as { resolveTarget?: unknown }[]
    expect(colors[0].resolveTarget).toBeUndefined()
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
      renderer: {},
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

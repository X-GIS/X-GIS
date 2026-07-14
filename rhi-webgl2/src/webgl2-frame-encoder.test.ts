import { describe, it, expect } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'
import type { RhiRenderPassDesc } from '@xgis/rhi'

// ═══ #1046 F3 — the WebGL2 frame encoder's universal beginRenderPass ═══════════
//
// F3 (doc §2.4 / §3-F3) gives the WebGl2Device a UNIVERSAL beginRenderPass so the
// unified `this._nodes` chain can originate its passes on WebGL2 through
// `ctx.encoder.beginRenderPass` (the #1049 descriptor-parity umbrella). It absorbs
// the offscreen/MRT arm (the proven beginOffscreenPass) and adds the FBO-0 SENTINEL
// arm: when a colour attachment view is the acquireScreenView sentinel, bind the
// default framebuffer. These are the GPU-free shape tests — a fake gl records the
// calls so the FBO-0 target + viewport + clear + fail-loud semantics are pinned
// without a real context (the real-GPU render is the orchestrator's e2e gate).
//
// Two invariants are load-bearing:
//   1. The sentinel-clear arm is GL-call-IDENTICAL to beginScreenPass (so routing a
//      screen pass through the universal encoder is byte-identical to the twin's).
//   2. The default framebuffer cannot MRT / resolve (caps.presentablePassMrt=false,
//      caps.maxSampleCount=1) → a descriptor that asks for it FAILS LOUD, never
//      silently degrades (#1049: bind correctly or fail loud).

interface Call {
  fn: string
  args: unknown[]
}

function fakeGl(errorQueue: number[] = []): {
  gl: WebGL2RenderingContext
  calls: Call[]
} {
  const calls: Call[] = []
  const rec =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args })
    }
  const gl = {
    // constants
    FRAMEBUFFER: 0x8d40,
    SCISSOR_TEST: 0x0c11,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    STENCIL_BUFFER_BIT: 0x0400,
    NO_ERROR: 0,
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    // the default-framebuffer size the FBO-0 sentinel arm reads for its viewport
    drawingBufferWidth: 320,
    drawingBufferHeight: 200,
    bindFramebuffer: rec('bindFramebuffer'),
    viewport: rec('viewport'),
    disable: rec('disable'),
    colorMask: rec('colorMask'),
    clearColor: rec('clearColor'),
    stencilMask: rec('stencilMask'),
    clearStencil: rec('clearStencil'),
    depthMask: rec('depthMask'),
    clearDepth: rec('clearDepth'),
    clear: rec('clear'),
    flush: rec('flush'),
    getError(): number {
      return errorQueue.length ? errorQueue.shift()! : 0
    },
  } as unknown as WebGL2RenderingContext
  return { gl, calls }
}

/** A screen-present descriptor mirroring the twin's beginScreenPass clear (colour +
 *  depth + stencil), targeting the FBO-0 sentinel from acquireScreenView. */
function screenClearDesc(dev: WebGl2Device): RhiRenderPassDesc {
  const screen = dev.acquireScreenView()
  return {
    colorAttachments: [
      { view: screen, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
    ],
    depthStencilAttachment: {
      view: screen,
      depthLoadOp: 'clear',
      depthClearValue: 1,
      depthStoreOp: 'store',
      stencilLoadOp: 'clear',
      stencilClearValue: 0,
      stencilStoreOp: 'store',
    },
  }
}

describe('WebGl2 frame encoder — universal beginRenderPass (#1046 F3)', () => {
  it('acquireFrameEncoder().beginRenderPass targets FBO 0 with the drawing-buffer viewport', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    dev.acquireFrameEncoder().beginRenderPass(screenClearDesc(dev))

    const bind = calls.find((c) => c.fn === 'bindFramebuffer')!
    expect(bind.args[0]).toBe(0x8d40) // FRAMEBUFFER
    expect(bind.args[1]).toBeNull() // FBO 0 = default framebuffer
    // viewport comes from gl.drawingBufferWidth/Height (the presented surface size)
    expect(calls.find((c) => c.fn === 'viewport')!.args).toEqual([0, 0, 320, 200])
    // colorMask unmask (#1043) must precede the clear so a dark writeMask can't no-op it
    const colorMaskIdx = calls.findIndex(
      (c) => c.fn === 'colorMask' && c.args.length === 4 && c.args.every((v) => v === true),
    )
    const clearIdx = calls.findIndex((c) => c.fn === 'clear')
    expect(colorMaskIdx).toBeGreaterThanOrEqual(0)
    expect(colorMaskIdx).toBeLessThan(clearIdx)
    // one clear of colour|depth|stencil
    expect(calls.find((c) => c.fn === 'clear')!.args[0]).toBe(0x4000 | 0x0100 | 0x0400)
  })

  it('the sentinel-clear arm is GL-call-identical to beginScreenPass (screen-pass parity)', () => {
    // Route a screen present through the universal encoder vs. the twin's beginScreenPass
    // for the SAME clear; the recorded call sequences must match exactly, so swapping the
    // twin's screen pass onto the universal encoder is byte-identical.
    const enc = fakeGl()
    new WebGl2Device(enc.gl)
      .acquireFrameEncoder()
      .beginRenderPass(screenClearDesc(new WebGl2Device(enc.gl)))

    const twin = fakeGl()
    new WebGl2Device(twin.gl).beginScreenPass({ width: 320, height: 200, clear: [0, 0, 0, 1] })

    const sig = (calls: Call[]) => calls.map((c) => `${c.fn}(${JSON.stringify(c.args)})`)
    expect(sig(enc.calls)).toEqual(sig(twin.calls))
  })

  it('a load-op colour attachment skips the clear (load semantics)', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    const screen = dev.acquireScreenView()
    dev.acquireFrameEncoder().beginRenderPass({
      colorAttachments: [{ view: screen, loadOp: 'load', storeOp: 'store' }],
    })
    expect(calls.some((c) => c.fn === 'clearColor')).toBe(false)
    expect(calls.some((c) => c.fn === 'clear')).toBe(false)
    // still binds FBO 0 + sets the viewport
    expect(calls.find((c) => c.fn === 'bindFramebuffer')!.args[1]).toBeNull()
  })

  it('a screen descriptor with a 2nd colour attachment FAILS LOUD (presentablePassMrt=false)', () => {
    const { gl } = fakeGl()
    const dev = new WebGl2Device(gl)
    const screen = dev.acquireScreenView()
    expect(() =>
      dev.acquireFrameEncoder().beginRenderPass({
        colorAttachments: [
          { view: screen, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          { view: screen, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      }),
    ).toThrow(/presentablePassMrt/)
  })

  it('a screen descriptor with a resolveTarget FAILS LOUD (maxSampleCount=1)', () => {
    const { gl } = fakeGl()
    const dev = new WebGl2Device(gl)
    const screen = dev.acquireScreenView()
    expect(() =>
      dev.acquireFrameEncoder().beginRenderPass({
        colorAttachments: [
          {
            view: screen,
            resolveTarget: screen,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
      }),
    ).toThrow(/resolve/)
  })

  it('the frame encoder finish() flushes and drains gl.getError (the present analog)', () => {
    const { gl, calls } = fakeGl([0x0500, 0x0502]) // INVALID_ENUM, INVALID_OPERATION, then NO_ERROR
    const dev = new WebGl2Device(gl)
    dev.acquireFrameEncoder().finish()
    expect(calls.some((c) => c.fn === 'flush')).toBe(true)
    expect(dev.takeGlErrors()).toEqual(['gl.getError 0x500', 'gl.getError 0x502'])
  })

  it('the copy-scoped encoder stays fail-closed while the frame encoder originates passes', () => {
    const { gl } = fakeGl()
    const dev = new WebGl2Device(gl)
    // createCommandEncoder = the out-of-frame utility encoder: beginRenderPass fail-closed
    // so a stray utility copy can never originate a render pass.
    expect(() =>
      dev.createCommandEncoder().beginRenderPass({
        colorAttachments: [{ view: dev.acquireScreenView(), loadOp: 'load', storeOp: 'store' }],
      }),
    ).toThrow(/copy-scoped/)
    // acquireFrameEncoder = the frame encoder: the SAME descriptor originates the pass.
    expect(() =>
      dev.acquireFrameEncoder().beginRenderPass({
        colorAttachments: [{ view: dev.acquireScreenView(), loadOp: 'load', storeOp: 'store' }],
      }),
    ).not.toThrow()
  })
})

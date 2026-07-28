// ═══ Overdraw-compose → RHI seam wiring (#1046 Inc-3a — the 12th pass) ═══
//
// The debug compose originates through the RHI frame shell like every other
// chain pass: the pass begins on the frame RHI encoder targeting the SCREEN
// bridge by IDENTITY (it composes onto the swapchain — ?debug=overdraw pins
// the ladder scale to 1, so screen === scene there), and the native
// pipeline/bind-group internals ride ONE boundary unwrap (the VTR idiom —
// the pipeline itself is gap-blocked debt, not re-wrapped state). Raw-shell
// escape fails loud naming the pass.
//
// Fail-before: on the native body every case except the accumulator gate is
// RED — the pass begins on the DECOY native ctx.encoder and the raw-shell
// case encodes instead of throwing.

import { describe, it, expect, vi } from 'vitest'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import { overdrawComposePass } from './overdraw-compose-pass'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

function harness(opts: { rawShell?: boolean; noAccum?: boolean } = {}) {
  const calls: string[] = []
  const nativePass = {
    setPipeline: () => calls.push('pipeline'),
    setBindGroup: () => calls.push('bindgroup'),
    draw: (n: number) => calls.push(`draw${n}`),
    end: () => calls.push('end'),
  }
  const captured: { desc: Record<string, unknown> }[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    captured.push({ desc })
    return wrapWebGpuPass(nativePass as unknown as GPURenderPassEncoder)
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  const nativeBegin = vi.fn(() => nativePass)
  const screenView = { __rhiScreenView: true }
  const ctx = {
    rhiEncoder: opts.rawShell ? null : enc,
    rhiScreenView: opts.rawShell ? null : screenView,
    rhiColorView: opts.rawShell ? null : { __rhiColorView: true },
    rhiStencilView: opts.rawShell ? null : { __rhiStencilView: true },
    rhiSceneResolveView: opts.rawShell ? null : { __rhiSceneResolveView: true },
    rhiColorViewScreen: opts.rawShell ? null : { __rhiColorViewScreen: true },
    encoder: { beginRenderPass: nativeBegin },
    screenView: { __nativeScreenView: true },
    passScope: (_l: string, fn: () => void) => fn(),
    rt: { overdrawAccumTexture: opts.noAccum ? null : {}, overdrawView: {} },
  } as unknown as FrameContext
  const host = {
    ctx: { device: { createBindGroup: () => ({}) } },
    renderer: {
      ensureOverdrawCompose: () => ({ __pipeline: true }),
      overdrawComposeBindGroupLayout: {},
    },
  }
  return { ctx, host, captured, beginRenderPass, nativeBegin, screenView, calls }
}

describe('overdraw-compose — RHI seam wiring (#1046 Inc-3a)', () => {
  it('originates on the frame RHI encoder targeting the SCREEN bridge; internals ride ONE unwrap', () => {
    const h = harness()
    overdrawComposePass.execute(h.ctx, {} as SceneView, h.host as never)
    expect(h.nativeBegin).not.toHaveBeenCalled()
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    const colors = h.captured[0].desc.colorAttachments as {
      view: unknown
      clearValue?: unknown
      loadOp: string
      storeOp: string
    }[]
    expect(colors[0].view).toBe(h.screenView)
    expect(colors[0].clearValue).toEqual([0, 0, 0, 1])
    expect(colors[0].loadOp).toBe('clear')
    expect(colors[0].storeOp).toBe('store')
    // The native colormap draw ran on the unwrapped handle, then the RHI
    // wrapper ended the pass.
    expect(h.calls).toEqual(['pipeline', 'bindgroup', 'draw3', 'end'])
  })

  it('no accumulator (not a ?debug=overdraw frame) ⇒ encodes nothing', () => {
    const h = harness({ noAccum: true })
    overdrawComposePass.execute(h.ctx, {} as SceneView, h.host as never)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
    expect(h.nativeBegin).not.toHaveBeenCalled()
  })

  it('raw-shell escape ⇒ throws naming the pass, encodes nothing', () => {
    const h = harness({ rawShell: true })
    expect(() => overdrawComposePass.execute(h.ctx, {} as SceneView, h.host as never)).toThrow(
      /overdraw-compose/,
    )
    expect(h.nativeBegin).not.toHaveBeenCalled()
  })
})

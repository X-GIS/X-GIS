// ═══ Scene-upscale seam wiring (#1429 INC-2) ═══
//
// The seam originates through the RHI frame shell and joins the two halves
// the partition keeps apart: it samples the resolved scene colour
// (rhiSceneColorSampleView) and writes the SCREEN-side colour attachment
// (rhiColorViewScreen — a DISTINCT token from the scene MSAA, so a revert to
// either side fails a pin), claims the MSAA resolve (the one UNCONDITIONAL
// swapchain writer of a scaled frame — review CRITICAL-1) and no depth. shouldRun is the scale-1 constructive no-op:
// false unless the ladder holds the scene below native. A frame whose flags
// and bridges disagree (scaled but no sample source) fails loud.
//
// Fail-before: the structural gates carried this increment's RED half — the
// partition demanded the file, parity demanded the registration — and the
// mutation checks here were verified by hand-flipping the descriptor (view →
// rhiColorView, resolveTarget added) before the pins were locked.

import { describe, it, expect, vi } from 'vitest'
import { sceneUpscalePass } from './scene-upscale-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

interface CapturedPass {
  desc: Record<string, unknown>
  ended: boolean
  draws: number[]
}

function harness(
  opts: { scaled?: boolean; rawShell?: boolean; noSource?: boolean; useResolve?: boolean } = {},
) {
  const scaled = opts.scaled ?? true
  const captured: CapturedPass[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = {
      desc,
      ended: false,
      draws: [] as number[],
      end() {
        p.ended = true
      },
      setPipeline: () => undefined,
      setBindGroup: () => undefined,
      setVertexBuffer: () => undefined,
      draw(count: number) {
        p.draws.push(count)
      },
    }
    captured.push(p as unknown as CapturedPass)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  const sceneColorSampleView = { __sceneColorSample: true }
  const colorViewScreen = { __rhiColorViewScreen: true }
  const ctx = {
    rhiEncoder: opts.rawShell ? null : enc,
    rhiScreenView: opts.rawShell ? null : { __rhiScreenView: true },
    rhiColorView: opts.rawShell ? null : { __rhiColorView: true },
    rhiStencilView: opts.rawShell ? null : { __rhiStencilView: true },
    rhiSceneResolveView: opts.rawShell ? null : { __rhiSceneResolveView: true },
    rhiColorViewScreen: opts.rawShell ? null : colorViewScreen,
    rhiSceneColorSampleView: opts.rawShell || opts.noSource ? null : sceneColorSampleView,
    passScope: (_l: string, fn: () => void) => fn(),
    projection: makeProjectionToken(0, 0, 0),
    scene: scaled ? { w: 576, h: 416, dpr: 0.72 } : { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    sampleCount: opts.useResolve === false ? 1 : 4,
    useResolve: opts.useResolve ?? true,
  } as unknown as FrameContext
  // Bind-group capture: the seam's ONE group is (sampler, scene colour).
  const bindGroups: { entries: { binding: number; resource: unknown }[] }[] = []
  const rhi = {
    backend: 'webgpu',
    createSampler: () => ({ __sampler: true }),
    createPipeline: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: (_layout: unknown, entries: { binding: number; resource: unknown }[]) => {
      bindGroups.push({ entries })
      return { __bg: true }
    },
  }
  const host = { ctx: { rhi, format: 'bgra8unorm' } }
  const scene = { sceneScaled: scaled } as unknown as SceneView
  return {
    ctx,
    host,
    scene,
    captured,
    beginRenderPass,
    bindGroups,
    sceneColorSampleView,
    colorViewScreen,
  }
}

describe('scene-upscale — the seam (#1429 INC-2)', () => {
  it('shouldRun is the scale-1 constructive no-op: only a scaled scene runs the seam', () => {
    expect(sceneUpscalePass.shouldRun({ sceneScaled: false } as never)).toBe(false)
    expect(sceneUpscalePass.shouldRun({ sceneScaled: true } as never)).toBe(true)
  })

  it('originates on the frame RHI encoder: writes the SCREEN colour attachment, clears, never resolves', () => {
    const h = harness()
    sceneUpscalePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    const desc = h.captured[0].desc
    const colors = desc.colorAttachments as {
      view: unknown
      resolveTarget?: unknown
      loadOp: string
      storeOp: string
    }[]
    expect(colors).toHaveLength(1)
    // The SCREEN side by identity — rhiColorView (the scene MSAA) is a decoy.
    expect(colors[0].view).toBe(h.colorViewScreen)
    expect(colors[0].loadOp).toBe('clear')
    expect(colors[0].storeOp).toBe('store')
    // The seam is the scaled frame's one UNCONDITIONAL swapchain writer
    // (review CRITICAL-1): under MSAA it must claim the resolve — labels,
    // heatmap and graphics are all content-gated, so a label-less style
    // otherwise presents a never-written swapchain (black frame).
    expect(colors[0].resolveTarget).toBe((h.ctx as { rhiScreenView: unknown }).rhiScreenView)
    expect(desc.depthStencilAttachment).toBeUndefined()
    expect(h.captured[0].ended).toBe(true)
    // The fullscreen triangle landed on THAT pass.
    expect(h.captured[0].draws).toEqual([3])
    // The draper sampled the RESOLVED scene colour, not either attachment.
    const entries = h.bindGroups.at(-1)!.entries
    expect(
      entries.some((e) => (e.resource as { view?: unknown }).view === h.sceneColorSampleView),
    ).toBe(true)
  })

  it('single-sample scaled frame (sc===1) ⇒ direct swapchain write, no resolve to claim', () => {
    const h = harness({ useResolve: false })
    sceneUpscalePass.execute(h.ctx, h.scene, h.host as never)
    const colors = h.captured[0].desc.colorAttachments as { resolveTarget?: unknown }[]
    expect(colors[0].resolveTarget).toBeUndefined()
  })

  it('a frame whose flags and bridges disagree fails loud naming the seam', () => {
    const h = harness({ noSource: true })
    expect(() => sceneUpscalePass.execute(h.ctx, h.scene, h.host as never)).toThrow(/scene-upscale/)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })

  it('twin-frame null bridges ⇒ throws naming the seam, encodes nothing', () => {
    const h = harness({ rawShell: true })
    expect(() => sceneUpscalePass.execute(h.ctx, h.scene, h.host as never)).toThrow(/scene-upscale/)
  })
})

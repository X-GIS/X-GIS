// background-pattern → the background pass's FIRST draw (#777 I-E), GPU-free.
//
// Drives the REAL backgroundPass.execute against a fake FrameContext + host +
// stub RHI, recording the ordered stream of encoder / render-pass calls. It
// proves the WIRE the stub tests demand:
//   • with a pattern + a loaded atlas, a fullscreen draw(3) is recorded AFTER
//     the coverage clear, through the dual-source background-pattern pipeline
//     (createPipeline received WGSL `code` + GLSL `vsCode`/`fsCode`, entries
//     vs_full / fs_pattern), bound to the sprite atlas view + sampler;
//   • absent pattern → clear-only, byte-identical (no wrapWebGpuPass, no draw,
//     same colour-attachment descriptor);
//   • a sprite name not in the atlas (missing-sprite policy) → clear-only.
//
// Fail-before: the pattern name never reaches the pass (background-pass.ts is
// clear-only), so no draw is ever recorded and the "draw after clear" assertion
// goes red.
//
// wrapWebGpuPass is mocked to hand the recording fake pass straight back as the
// RhiRenderPass — the real WebGPU unwrap machinery is exercised by
// rhi-webgpu's own suites; here we only assert the pass RECORDS a draw.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xgis/rhi-webgpu', () => ({
  // The pass records its pattern draw against whatever wrapWebGpuPass returns;
  // returning the fake pass itself routes setPipeline/draw straight to it.
  wrapWebGpuPass: (enc: unknown) => enc,
}))

import { backgroundPass } from './background-pass'
import type { BackgroundPassHost } from './pass'
import type { FrameContext } from '../frame-context'
import { makeProjectionToken } from '../projection-token'

type Ev =
  | { t: 'begin'; loadOp: string; clearValue: { r: number; g: number; b: number; a: number } }
  | { t: 'setPipeline' }
  | { t: 'setBindGroup'; index: number; entries: number }
  | { t: 'draw'; count: number }
  | { t: 'end' }

interface Captured {
  events: Ev[]
  pipelineDescs: Array<Record<string, unknown>>
  bindGroupEntries: Array<Array<{ binding: number; resource: unknown }>>
  wrote: boolean
}

const SPRITE = { name: 'pat', x: 0, y: 0, width: 16, height: 16, pixelRatio: 1, sdf: false }
const BG: [number, number, number, number] = [0.13, 0.57, 0.42, 1]

/** Build the fake frame + host and run the real backgroundPass.execute. */
function run(patternName: string | null, atlasStatus: 'loaded' | 'loading' = 'loaded'): Captured {
  const cap: Captured = { events: [], pipelineDescs: [], bindGroupEntries: [], wrote: false }

  const fakePass = {
    setPipeline: () => cap.events.push({ t: 'setPipeline' }),
    setBindGroup: (index: number, _g: unknown) =>
      cap.events.push({ t: 'setBindGroup', index, entries: 0 }),
    draw: (count: number) => cap.events.push({ t: 'draw', count }),
    end: () => cap.events.push({ t: 'end' }),
  }

  const encoder = {
    beginRenderPass: (desc: {
      colorAttachments: Array<{
        loadOp: string
        clearValue: Ev extends { clearValue: infer C } ? C : never
      }>
    }) => {
      const a = desc.colorAttachments[0]!
      cap.events.push({ t: 'begin', loadOp: a.loadOp, clearValue: a.clearValue })
      return fakePass
    },
  }

  // Stub RHI device — enough surface for the pattern pipeline + bind group.
  const rhi = {
    createBindGroupLayout: () => ({ __rhi: 'bindlayout' }),
    createBuffer: () => ({ __rhi: 'buffer' }),
    writeBuffer: () => {
      cap.wrote = true
    },
    createPipeline: (desc: Record<string, unknown>) => {
      cap.pipelineDescs.push(desc)
      return { __rhi: 'pipeline' }
    },
    createBindGroup: (_layout: unknown, entries: Array<{ binding: number; resource: unknown }>) => {
      cap.bindGroupEntries.push(entries)
      return { __rhi: 'bindgroup' }
    },
  }

  const iconStage = {
    host: {
      getState: () => ({ status: atlasStatus }),
      get: (n: string) => (n === 'pat' ? SPRITE : undefined),
    },
    gpu: {
      rhiView: () => ({ __rhi: 'view' }),
      rhiSampler: () => ({ __rhi: 'sampler' }),
      size: () => ({ width: 64, height: 64 }),
    },
  }

  const ctx = {
    encoder,
    colorView: {},
    camera: { zoom: 5 } as unknown as FrameContext['camera'],
    projection: makeProjectionToken(0, 0, 0), // flat mercator → clear = background
    elapsedMs: 0,
    frameCount: 0,
    w: 800,
    h: 600,
    dpr: 2,
    sampleCount: 4,
    rhi,
    passScope: (_label: string, fn: () => void) => fn(),
  } as unknown as FrameContext

  const host = {
    _backgroundColor: BG,
    _backgroundColorShape: null,
    _backgroundOpacityShape: null,
    _backgroundPattern: patternName,
    ctx: { format: 'bgra8unorm' },
    iconStage,
  } as unknown as BackgroundPassHost

  backgroundPass.execute(ctx, undefined as never, host as never)
  return cap
}

describe('background-pattern → first draw after the clear (GPU-free)', () => {
  beforeEach(() => {
    // The singleton pass caches per-device; a fresh stub rhi per run() trips its
    // device-swap guard, but reset any residual mock call state here.
    vi.clearAllMocks()
  })

  it('records a fullscreen draw(3) AFTER the coverage clear when a pattern is set', () => {
    const { events } = run('pat')
    const beginIdx = events.findIndex((e) => e.t === 'begin')
    const drawIdx = events.findIndex((e) => e.t === 'draw')
    expect(beginIdx, 'the clear render pass must open').toBeGreaterThanOrEqual(0)
    expect(drawIdx, 'a pattern draw must be recorded').toBeGreaterThan(beginIdx)
    // The clear still fills the whole viewport with the background colour.
    const begin = events[beginIdx] as Extract<Ev, { t: 'begin' }>
    expect(begin.loadOp).toBe('clear')
    expect(begin.clearValue).toEqual({ r: BG[0], g: BG[1], b: BG[2], a: BG[3] })
    // Fullscreen triangle (3 verts), pipeline + atlas bind group set first.
    const draw = events[drawIdx] as Extract<Ev, { t: 'draw' }>
    expect(draw.count).toBe(3)
    expect(events.some((e) => e.t === 'setPipeline')).toBe(true)
    expect(events.some((e) => e.t === 'setBindGroup')).toBe(true)
    // …and the render pass still ends (the draw is INSIDE the clear pass).
    expect(events.at(-1)?.t).toBe('end')
  })

  it('builds a DUAL-SOURCE pipeline (WGSL + GLSL twins) matched to the frame target', () => {
    const { pipelineDescs, bindGroupEntries, wrote } = run('pat')
    expect(pipelineDescs).toHaveLength(1)
    const d = pipelineDescs[0]!
    expect(d.vsEntry).toBe('vs_full')
    expect(d.fsEntry).toBe('fs_pattern')
    // WGSL twin + BOTH GLSL twins present (the F3/F4 WebGL2 requirement).
    expect(String(d.code)).toContain('fs_pattern')
    expect(String(d.code)).toContain('fract(')
    expect(String(d.vsCode)).toContain('#version 300 es')
    expect(String(d.fsCode)).toContain('#version 300 es')
    // Matched to the frame's swapchain format + MSAA sample count.
    expect(d.colorTargets).toEqual([{ format: 'bgra8unorm', blend: 'alpha' }])
    expect(d.sampleCount).toBe(4)
    // The uniform is written and the atlas view + sampler are bound at 1 / 2.
    expect(wrote).toBe(true)
    const entries = bindGroupEntries.at(-1)!
    expect(entries.map((e) => e.binding)).toEqual([0, 1, 2])
    expect(entries[1]!.resource).toEqual({ view: { __rhi: 'view' } })
    expect(entries[2]!.resource).toEqual({ sampler: { __rhi: 'sampler' } })
  })

  it('absent pattern → clear-only, byte-identical (no draw)', () => {
    const { events, pipelineDescs } = run(null)
    expect(events.some((e) => e.t === 'draw')).toBe(false)
    expect(events.some((e) => e.t === 'setPipeline')).toBe(false)
    expect(pipelineDescs).toHaveLength(0)
    // Only the clear + end — the exact pre-#777 shape.
    expect(events.map((e) => e.t)).toEqual(['begin', 'end'])
    const begin = events[0] as Extract<Ev, { t: 'begin' }>
    expect(begin.loadOp).toBe('clear')
    expect(begin.clearValue).toEqual({ r: BG[0], g: BG[1], b: BG[2], a: BG[3] })
  })

  it('missing sprite (name not in the atlas) → clear-only (missing-sprite policy)', () => {
    const { events } = run('not-in-atlas')
    expect(events.some((e) => e.t === 'draw')).toBe(false)
    expect(events.map((e) => e.t)).toEqual(['begin', 'end'])
  })

  it('atlas not loaded yet → clear-only (skip the draw, keep the clear)', () => {
    const { events } = run('pat', 'loading')
    expect(events.some((e) => e.t === 'draw')).toBe(false)
    expect(events.map((e) => e.t)).toEqual(['begin', 'end'])
  })
})

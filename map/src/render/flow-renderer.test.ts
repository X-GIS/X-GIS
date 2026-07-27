import { describe, it, expect } from 'vitest'
import { FlowRenderer } from './flow-renderer'
import type { FlowFieldRegion } from './coverage-renderer'
import type { RhiCommandEncoder, RhiDevice } from '@xgis/engine'

// The IBFV advection arm (#1333). Everything here is a property this environment CANNOT see by
// looking at a frame: a recursive filter that clears at the wrong moment, samples the
// attachment it writes, or runs a pipeline compiled for the other storage format still
// produces an animating image — a wrong one. So each is pinned against a recorder instead.

interface Recorded {
  label?: string
  view: unknown
  loadOp: string
  clearValue?: readonly number[]
}

interface PassRec {
  desc: Recorded
  bindGroups: unknown[]
  ended: boolean
}

function makeCtx(opts: { backend: 'webgl2' | 'webgpu'; floatBlendTargets?: boolean }) {
  let id = 0
  const passes: PassRec[] = []
  const pipelines: { format: string }[] = []
  const bindGroups: { entries: unknown[]; id: number }[] = []
  const destroyed: unknown[] = []
  const samplers: unknown[] = []

  const openPass = (desc: { colorAttachments: Recorded[]; label?: string }): unknown => {
    const rec: PassRec = {
      desc: { ...desc.colorAttachments[0]!, label: desc.label },
      bindGroups: [],
      ended: false,
    }
    passes.push(rec)
    return {
      setPipeline: () => {},
      setBindGroup: (_g: number, bg: unknown) => void rec.bindGroups.push(bg),
      draw: () => {},
      end: () => {
        rec.ended = true
      },
    }
  }

  const rhi = {
    backend: opts.backend,
    caps: { floatBlendTargets: opts.floatBlendTargets ?? false, maxSampleCount: 1 },
    createTexture: () => ({ native: `tex${id++}` }),
    createView: (t: { native: string }) => ({ native: `view-of-${t.native}` }),
    destroyTexture: (t: unknown) => void destroyed.push(t),
    createSampler: () => {
      const s = { native: `samp${id++}` }
      samplers.push(s)
      return s
    },
    destroySampler: (s: unknown) => void destroyed.push(s),
    createShaderModule: () => ({ native: 'mod' }),
    createBindGroupLayout: () => ({ native: 'layout' }),
    createBindGroup: (_l: unknown, entries: unknown[]) => {
      const bg = { entries, id: id++ }
      bindGroups.push(bg)
      return bg
    },
    createPipeline: (d: { colorTargets?: { format: string }[] }) => {
      pipelines.push({ format: d.colorTargets?.[0]?.format ?? '?' })
      return { native: 'pipe' }
    },
    createBuffer: () => ({ native: 'buf' }),
    writeBuffer: () => {},
    // Present ONLY on webgl2, because `asScreenPassDevice` narrows on exactly these.
    ...(opts.backend === 'webgl2'
      ? {
          beginScreenPass: () => ({}),
          endScreenPass: () => {},
          beginOffscreenPass: openPass,
          readPixelRg32ui: () => [0, 0],
        }
      : {}),
  }

  // The non-WebGL2 arm records into the FRAME's encoder — the same object the loop hands in.
  const encoder = {
    beginRenderPass: (d: { colorAttachments: Recorded[]; label?: string }) => openPass(d),
  } as unknown as RhiCommandEncoder

  const dev = rhi as unknown as RhiDevice
  return { dev, encoder, passes, pipelines, bindGroups, destroyed, samplers, rhi }
}

let fieldId = 0
function makeField(over: Partial<FlowFieldRegion> = {}): FlowFieldRegion {
  const n = fieldId++
  return {
    u: { native: `u${n}` } as never,
    v: { native: `v${n}` } as never,
    scale: 1.5,
    width: 8,
    height: 8,
    spanDeg: [2, 2],
    midLatDeg: 40,
    ...over,
  }
}

const frameAt = (ms: number, encoder: RhiCommandEncoder | null = null) => ({
  elapsedMs: ms,
  encoder,
})

describe('FlowRenderer — the advection arm (#1333)', () => {
  it('THE CLEAR OBLIGATION: both sides are wiped before the FIRST advect, and never again', () => {
    // A fresh texture's contents are undefined, and a recursive filter feeds on them rather
    // than overwriting them — uninitialized memory would sit in the history for the session.
    // Clearing every frame is the mirror failure: the trail could never accumulate.
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    const field = makeField()
    fr.step(frameAt(0), field)
    expect(t.passes.map((p) => `${p.desc.label}:${p.desc.loadOp}`)).toEqual([
      'flow-clear:clear',
      'flow-clear:clear',
      'flow-advect:load',
    ])
    // ...and the two clears hit DIFFERENT textures — clearing one side twice leaves the other
    // holding garbage, which is the same bug wearing a passing test.
    expect(t.passes[0]!.desc.view).not.toEqual(t.passes[1]!.desc.view)

    t.passes.length = 0
    fr.step(frameAt(16), field)
    fr.step(frameAt(32), field)
    expect(t.passes.map((p) => p.desc.label)).toEqual(['flow-advect', 'flow-advect'])
  })

  it('never samples the attachment it writes', () => {
    // Undefined behaviour on both backends, and it renders *something* either way.
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    const field = makeField()
    fr.step(frameAt(0), field)
    fr.step(frameAt(16), field)
    const advect = t.passes.filter((p) => p.desc.label === 'flow-advect')
    for (const p of advect) {
      const bg = p.bindGroups[0] as { entries: { binding: number; resource: { view?: unknown } }[] }
      const prev = bg.entries.find((e) => e.binding === 0)!.resource.view
      expect(prev).not.toEqual(p.desc.view)
    }
    // And the pair really alternates, so the second step reads what the first wrote.
    expect(advect[0]!.desc.view).not.toEqual(advect[1]!.desc.view)
  })

  it('THE FORMAT AGREEMENT: the pipeline is built for the format the pair was allocated with', () => {
    // A pipeline compiled for r16float rendering into an rgba8unorm attachment is a validation
    // error on WebGPU and a silently wrong image on WebGL2. The two decisions are made from the
    // same capability, in this class, so they cannot drift.
    for (const [floatBlendTargets, want] of [
      [true, 'r16float'],
      [false, 'rgba8unorm'],
    ] as const) {
      const t = makeCtx({ backend: 'webgl2', floatBlendTargets })
      new FlowRenderer(t.dev).step(frameAt(0), makeField())
      expect(t.pipelines.map((p) => p.format)).toEqual([want])
    }
  })

  it('the bind group is MEMOIZED per ping-pong side — two, not one per frame', () => {
    // The 60 Hz path must not mint a GPU object every frame. Two sides ⇒ exactly two groups,
    // however many frames run.
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    const field = makeField()
    for (let i = 0; i < 10; i++) fr.step(frameAt(i * 16), field)
    expect(t.bindGroups).toHaveLength(2)
  })

  it('...and DROPPED when the coverage re-arms, so a stale group cannot pin last hour’s field', () => {
    // Stepping the forecast hour re-uploads the velocity pair. Keeping the memo would leave the
    // animation running on the PREVIOUS hour's currents — an image that still looks alive.
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    const first = makeField()
    fr.step(frameAt(0), first)
    fr.step(frameAt(16), first)
    expect(t.bindGroups).toHaveLength(2)
    const next = makeField() // new upload → new views
    fr.step(frameAt(32), next)
    expect(t.bindGroups).toHaveLength(3)
    const bg = t.bindGroups[2]!.entries as { binding: number; resource: { view?: unknown } }[]
    expect(bg.find((e) => e.binding === 1)!.resource.view).toEqual(next.u)
    expect(bg.find((e) => e.binding === 2)!.resource.view).toEqual(next.v)
  })

  it('THE FORK, WebGL2 arm: nests an offscreen pass off the DEVICE, touching no encoder', () => {
    const t = makeCtx({ backend: 'webgl2' })
    new FlowRenderer(t.dev).step(frameAt(0, null), makeField())
    expect(t.passes.length).toBeGreaterThan(0)
    expect(t.passes.every((p) => p.ended)).toBe(true)
  })

  it('THE FORK, WebGPU arm: records into THIS frame’s encoder', () => {
    // The frame's encoder, handed in — NOT one fetched here: `acquireFrameEncoder` mints a new
    // native encoder per call, so reaching for it mid-frame would strand these commands outside
    // the frame's single submit.
    const t = makeCtx({ backend: 'webgpu' })
    new FlowRenderer(t.dev).step(frameAt(0, t.encoder), makeField())
    expect(t.passes.map((p) => p.desc.label)).toEqual(['flow-clear', 'flow-clear', 'flow-advect'])
  })

  it('no encoder at all draws NOTHING rather than throwing into the render loop', () => {
    // The `__xgisRawFrameShell` rollback leaves the FrameContext with no RHI encoder.
    const t = makeCtx({ backend: 'webgpu' })
    expect(() => new FlowRenderer(t.dev).step(frameAt(0, null), makeField())).not.toThrow()
    expect(t.passes).toHaveLength(0)
  })

  it('the FIRST frame advects by zero — there is no earlier frame to have moved across', () => {
    // The dt comes from deltas of the frame clock. Treating the first sample as elapsed time
    // would advect a just-cleared field by the whole startup interval in one step, and a
    // recursive filter has no way back from that.
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    const field = makeField()
    const uni: number[][] = []
    // The packed AdvectParams ride the uniform buffer; capture them off writeBuffer.
    ;(
      t.rhi as unknown as { writeBuffer: (b: unknown, o: number, d: Float32Array) => void }
    ).writeBuffer = (_b, _o, d) => void uni.push([...d])
    fr.step(frameAt(1000), field)
    fr.step(frameAt(1016), field)
    expect(uni[0]![0]).toBe(0) // stepX on frame 1
    expect(uni[0]![1]).toBe(0) // stepY on frame 1
    expect(uni[1]![0]).toBeGreaterThan(0)
    expect(uni[1]![1]).toBeGreaterThan(0)
  })

  it('dispose() frees the pair and the sampler', () => {
    const t = makeCtx({ backend: 'webgl2' })
    const fr = new FlowRenderer(t.dev)
    fr.step(frameAt(0), makeField())
    expect(fr.currentView).not.toBeNull()
    fr.dispose()
    expect(fr.currentView).toBeNull()
    expect(t.destroyed).toEqual(expect.arrayContaining(t.samplers))
    // Two ping-pong textures + the sampler.
    expect(t.destroyed).toHaveLength(3)
  })

  it('a degenerate grid renders nothing at all', () => {
    const t = makeCtx({ backend: 'webgl2' })
    new FlowRenderer(t.dev).step(frameAt(0), makeField({ width: 0 }))
    expect(t.passes).toHaveLength(0)
    expect(t.pipelines).toHaveLength(0)
  })
})

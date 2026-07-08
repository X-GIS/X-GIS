import { describe, it, expect, vi, beforeAll } from 'vitest'
import { GraphicsManager } from './graphics-manager'
import type { Camera } from '../camera'

// node lacks the WebGPU `GPUTextureUsage` global the host atlas ensure() reads.
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.GPUTextureUsage === undefined) {
    g.GPUTextureUsage = {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    }
  }
})

// GraphicsManager retained-batch LIFECYCLE (#797 P1) — the buffer-lifecycle paths
// the real-GPU perf/raster gates do NOT exercise (they assert render output, not
// buffer create/destroy). Driven on stub device/rhi handles so the create/write/
// destroy calls are observable without a GPU.

interface StubBuf {
  __id: number
  label?: string
}

function makeStubs() {
  let id = 0
  const created: StubBuf[] = []
  const destroyed: StubBuf[] = []
  const rhi = {
    createBuffer: (d: { label?: string }) => {
      const b: StubBuf = { __id: id++, label: d.label }
      created.push(b)
      return b
    },
    writeBuffer: () => {},
    destroyBuffer: (b: StubBuf) => {
      destroyed.push(b)
    },
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipeline: () => ({}),
  }
  const device = {
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    queue: { writeTexture: () => {}, copyExternalImageToTexture: () => {} },
  }
  return { rhi, device, created, destroyed }
}

// A minimal render call — the lifecycle tests all early-return before the draw
// loop (empty drawable / drain-only), so the pass + camera are never dereferenced.
function render(gm: GraphicsManager): void {
  gm.renderRetained(
    {} as never,
    { matrix: new Float32Array(16), logDepthFc: 0.03 },
    {} as unknown as Camera,
    0,
    0,
    0,
    800,
    600,
    1,
  )
}

function attach(gm: GraphicsManager, s: ReturnType<typeof makeStubs>): void {
  gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
}

// The node vitest env has no DOM ImageData; a plain {width,height,data} object is
// all the registry (reads w/h) + atlas (structural 'data' probe → writeTexture) need.
function stubImage(): ImageData {
  return {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255]),
  } as unknown as ImageData
}

function iconSpec(n: number) {
  const data = Array.from({ length: n }, (_, i) => ({ lon: i, lat: i % 80 }))
  return {
    type: 'icon' as const,
    data,
    getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat] as [number, number],
    getImage: 'pin',
    getColor: () => [1, 0, 0, 1] as [number, number, number, number],
    updateTriggers: { color: 1 },
  }
}

describe('#797 P1 GraphicsManager retained-batch lifecycle', () => {
  it('remove() frees the LAST batch buffers even when the map keeps running (drain reachable)', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.addImage('pin', stubImage())

    const handle = gm.add(iconSpec(1000)) // materialise (in add) creates feat+tint
    expect(s.created.length, 'feat + tint created').toBe(2)
    expect(s.destroyed.length).toBe(0)

    handle.remove()
    // The batch is gone, but its 2 buffers are pending in _retired — the gate MUST
    // still fire so the drain runs (finding 1: the leak this proves fixed).
    expect(gm.hasRetainedBatches(), 'gate stays true while buffers pend drain').toBe(true)

    render(gm) // drain-only frame: destroys the 2 retired buffers, then early-returns
    expect(s.destroyed.length, 'both retired buffers destroyed').toBe(2)
    expect(gm.hasRetainedBatches(), 'gate falls after drain').toBe(false)
  })

  it('an empty-data batch does NOT flip the render gate (byte-identical when nothing to draw)', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.addImage('pin', stubImage())
    gm.add(iconSpec(0))
    expect(gm.hasRetainedBatches()).toBe(false)
  })

  it('update({color}) re-uploads ONLY the tint buffer (integration)', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.addImage('pin', stubImage())
    const handle = gm.add(iconSpec(500))
    const before = gm.getWriteCounts()
    handle.update({ triggers: ['color'] })
    const after = gm.getWriteCounts()
    expect(after.tintWrites - before.tintWrites).toBe(1)
    expect(after.featWrites - before.featWrites).toBe(0)
  })

  it('update() rejects a data-length change loudly instead of overflowing the buffer', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.addImage('pin', stubImage())
    const spec = iconSpec(100)
    const handle = gm.add(spec)
    const before = gm.getWriteCounts()
    // Out-of-contract: grow the data array, then update — must NOT re-upload (would
    // overflow the 100-icon buffer) and must warn (finding 2).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(spec.data as { lon: number; lat: number }[]).push({ lon: 1, lat: 1 })
    handle.update({ triggers: ['position'] })
    const after = gm.getWriteCounts()
    expect(after.featWrites - before.featWrites, 'no overflow write').toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

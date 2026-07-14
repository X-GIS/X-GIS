import { describe, it, expect, vi, beforeAll } from 'vitest'
import { GraphicsManager } from './graphics-manager'
import type { Camera } from '../camera'
import {
  CIRCLE_RETAINED_FEAT,
  CIRCLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/circle-retained-feat-layout'

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

interface WriteRec {
  buf: StubBuf
  byteOffset: number
  byteLength: number
}

function makeStubs() {
  let id = 0
  const created: StubBuf[] = []
  const destroyed: StubBuf[] = []
  // Records the byte RANGE of every RHI writeBuffer (buffer identity + offset +
  // length) — the #797 P2a witness that a color-trigger update writes ONLY the
  // tint lane and an append writes ONLY the new rows into a new buffer.
  const writes: WriteRec[] = []
  const rhi = {
    createBuffer: (d: { label?: string }) => {
      const b: StubBuf = { __id: id++, label: d.label }
      created.push(b)
      return b
    },
    writeBuffer: (buf: StubBuf, byteOffset: number, data: { byteLength: number }) => {
      writes.push({ buf, byteOffset, byteLength: data.byteLength })
    },
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
  return { rhi, device, created, destroyed, writes }
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

// #797 CIRCLE primitive — the retained disc. Unlike icons it needs NO sprite atlas
// image, so add() works with a bare circle spec. Exercises the circle branch of
// materialise / updateBatch / removeBatch on the same stub device.
function circleSpec(n: number) {
  const data = Array.from({ length: n }, (_, i) => ({ lon: i, lat: i % 80 }))
  return {
    type: 'circle' as const,
    data,
    getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat] as [number, number],
    getRadius: 6,
    getColor: () => [1, 0, 0, 1] as [number, number, number, number],
    getStrokeColor: () => [1, 1, 1, 1] as [number, number, number, number],
    getStrokeWidth: 1,
    updateTriggers: { color: 1 },
  }
}

describe('#797 GraphicsManager retained CIRCLE batch', () => {
  it('add() materialises feat + tint with NO sprite image required', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    // No addImage — circles are procedural, not sprites.
    const handle = gm.add(circleSpec(1000))
    expect(s.created.length, 'feat + tint created').toBe(2)
    expect(gm.hasRetainedBatches()).toBe(true)
    handle.remove()
    render(gm) // drain-only frame destroys the retired buffers
    expect(s.destroyed.length, 'both retired buffers destroyed').toBe(2)
  })

  it('update({color}) re-uploads ONLY the fill-tint buffer', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const handle = gm.add(circleSpec(500))
    const before = gm.getWriteCounts()
    handle.update({ triggers: ['color'] })
    const after = gm.getWriteCounts()
    expect(after.tintWrites - before.tintWrites).toBe(1)
    expect(after.featWrites - before.featWrites).toBe(0)
  })

  it('an empty-data circle batch does NOT flip the render gate', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.add(circleSpec(0))
    expect(gm.hasRetainedBatches()).toBe(false)
  })
})

// #797 P2a — the incremental "O(changed)" witness the Phase-2 gate names: an
// updateTriggers recolour writes ONLY the tint byte-range (never repacking
// positions), and append adds rows WITHOUT re-uploading the existing ones. We
// SPY the writeBuffer(buffer, byteOffset, data) ranges through the RHI seam
// (makeStubs.writes) — the byte-level proof, stronger than the featWrites/
// tintWrites counters the landed lifecycle tests use.
const CIRCLE_FEAT = 'retained-circle-feat'
const CIRCLE_TINT = 'retained-circle-tint'
const FEAT_BYTES = (n: number) => n * CIRCLE_RETAINED_FEAT.stride * 4
const TINT_BYTES = (n: number) => n * CIRCLE_RETAINED_TINT_STRIDE * 4

describe('#797 P2a retained CIRCLE — writeBuffer-range witness + append', () => {
  it('update({color}) writes ONLY the tint byte-range — the feat/position buffer is never touched', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const n = 200
    const handle = gm.add(circleSpec(n))
    s.writes.length = 0 // ignore the materialise writes; measure ONLY the update
    handle.update({ triggers: ['color'] })
    // Exactly ONE writeBuffer — to the TINT buffer, at offset 0, covering the whole
    // fill-tint lane (n × 4 f32) — and ZERO writes to the feat (position) buffer.
    expect(s.writes.length).toBe(1)
    expect(s.writes[0]!.buf.label).toBe(CIRCLE_TINT)
    expect(s.writes[0]!.byteOffset).toBe(0)
    expect(s.writes[0]!.byteLength).toBe(TINT_BYTES(n))
    expect(
      s.writes.some((w) => w.buf.label === CIRCLE_FEAT),
      'no feat re-upload',
    ).toBe(false)
  })

  it('append() uploads ONLY the new rows into a NEW buffer — the seed batch bytes stay untouched', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const n0 = 100
    const handle = gm.add(circleSpec(n0))
    const seedBufs = new Set(s.created.map((b) => b.__id)) // the seed's feat + tint
    expect(seedBufs.size, 'seed feat + tint').toBe(2)
    s.writes.length = 0

    const n1 = 30
    handle.append(Array.from({ length: n1 }, (_, i) => ({ lon: 500 + i, lat: 10 })))

    // Two NEW buffers (feat + tint of the appended batch); the seed's two buffers
    // received ZERO writes (its rows are neither re-packed nor re-uploaded).
    const newIds = new Set(s.created.filter((b) => !seedBufs.has(b.__id)).map((b) => b.__id))
    expect(newIds.size, 'appended feat + tint (a separate batch)').toBe(2)
    expect(s.writes.length, 'only the 2 new-batch buffers written').toBe(2)
    for (const w of s.writes) {
      expect(seedBufs.has(w.buf.__id), 'no write hits a seed buffer').toBe(false)
      expect(newIds.has(w.buf.__id)).toBe(true)
    }
    // The appended writes cover exactly the new rows (n1), at offset 0 of their
    // own buffers — the O(changed) upload, not O(n0 + n1).
    const featW = s.writes.find((w) => w.buf.label === CIRCLE_FEAT)!
    const tintW = s.writes.find((w) => w.buf.label === CIRCLE_TINT)!
    expect(featW.byteOffset).toBe(0)
    expect(featW.byteLength).toBe(FEAT_BYTES(n1))
    expect(tintW.byteLength).toBe(TINT_BYTES(n1))
    // The handle now draws the union.
    expect(handle.count).toBe(n0 + n1)
  })

  it('append() runs accessors ONLY for the appended rows — the seed rows are not re-packed', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    let posCalls = 0
    const seed = {
      type: 'circle' as const,
      data: Array.from({ length: 100 }, (_, i) => ({ lon: i, lat: 0 })),
      getPosition: (d: { lon: number; lat: number }) => {
        posCalls++
        return [d.lon, d.lat] as [number, number]
      },
      getRadius: 5,
    }
    const handle = gm.add(seed)
    const afterAdd = posCalls // the seed pack ran getPosition once per seed row
    expect(afterAdd).toBe(100)
    handle.append([
      { lon: 900, lat: 1 },
      { lon: 901, lat: 2 },
    ])
    // Only the 2 appended rows are packed; the 100 seed rows are NOT re-run.
    expect(posCalls - afterAdd, 'accessors run for appended rows only').toBe(2)
    expect(handle.count).toBe(102)
  })

  it('append([]) is a no-op — no batch, no buffers, no repaint churn', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const handle = gm.add(circleSpec(50))
    const createdBefore = s.created.length
    handle.append([])
    expect(s.created.length, 'empty append allocates nothing').toBe(createdBefore)
    expect(handle.count).toBe(50)
  })
})

// #826 PARTICLE-FLOW primitive — the wind-map batch. Unlike the others, `data` is the per-gu FIELD
// that the packer EXPANDS into a fixed particle pool (design §2.3): the batch's instance count is
// that fixed pool (particleCount), decoupled from the gu count. Like the circle it needs NO sprite
// atlas. Exercises the particle branch of materialise / updateBatch / removeBatch on the stub device.
function particleSpec(cells: number, particleCount = 256) {
  const data = Array.from({ length: cells }, (_, i) => ({
    lon: i,
    lat: i % 80,
    bearing: (i * 37) % 360,
    vol: i + 1,
  }))
  type Cell = { lon: number; lat: number; bearing: number; vol: number }
  return {
    type: 'particle-flow' as const,
    data,
    getPosition: (d: Cell) => [d.lon, d.lat] as [number, number],
    getBearing: (d: Cell) => d.bearing,
    getVolume: (d: Cell) => d.vol,
    getColor: () => [1, 1, 1, 1] as [number, number, number, number],
    particleCount,
    minPerCell: 4,
    updateTriggers: { color: 1 },
  }
}

describe('#826 GraphicsManager retained PARTICLE-FLOW batch', () => {
  it('add() materialises feat + tint with NO sprite image; count = the fixed particle pool', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const handle = gm.add(particleSpec(5, 256))
    expect(s.created.length, 'feat + tint created').toBe(2)
    expect(gm.hasRetainedBatches()).toBe(true)
    // The draw count is the fixed pool (particleCount), NOT the 5 gu cells (density-expansion).
    expect(handle.count).toBe(256)
    handle.remove()
    render(gm) // drain-only frame destroys the retired buffers
    expect(s.destroyed.length, 'both retired buffers destroyed').toBe(2)
  })

  it('update({color}) re-packs feat AND tint together (colour follows the shared allocation)', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    const handle = gm.add(particleSpec(5, 256))
    const before = gm.getWriteCounts()
    handle.update({ triggers: ['color'] })
    const after = gm.getWriteCounts()
    // Particle colour is keyed to the per-gu allocation baked into the feat pack, so a recolour
    // re-packs BOTH lanes in lockstep (no color-only tint fast path) — the design's correctness fence.
    expect(after.tintWrites - before.tintWrites).toBe(1)
    expect(after.featWrites - before.featWrites).toBe(1)
  })

  it('an empty-field particle batch does NOT flip the render gate (0 particles)', () => {
    const s = makeStubs()
    const gm = new GraphicsManager()
    attach(gm, s)
    gm.add(particleSpec(0))
    expect(gm.hasRetainedBatches()).toBe(false)
  })
})

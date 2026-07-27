import { describe, it, expect, beforeAll } from 'vitest'
import { GraphicsManager } from './graphics-manager'
import type { Camera } from '../camera'

// Compiled `| arrow` layer LIFECYCLE (#1302, extracted to CompiledArrowStore in #1333).
//
// Driven through the GraphicsManager PUBLIC surface (addCompiledArrowLayer /
// clearCompiledArrows / renderRetained / destroyGpu) rather than against the store
// directly, so these gates pin the OBSERVABLE behaviour the extraction had to preserve —
// they would equally have passed before the split, and they fail if the delegation drops
// a step (retirement, DPR re-pack, the write-counter fold, the pass gate).
//
// Before the extraction this path had NO manager-level coverage at all: only the packer
// (compiled-arrow-packer.test.ts) and an e2e parity spec that needs a GPU.

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

interface StubBuf {
  __id: number
  label?: string
}

function makeStubs() {
  let id = 0
  const created: StubBuf[] = []
  const destroyed: StubBuf[] = []
  const writes: { buf: StubBuf; byteLength: number }[] = []
  const rhi = {
    createBuffer: (d: { label?: string }) => {
      const b: StubBuf = { __id: id++, label: d.label }
      created.push(b)
      return b
    },
    writeBuffer: (buf: StubBuf, _off: number, data: { byteLength: number }) => {
      writes.push({ buf, byteLength: data.byteLength })
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

/** The camera surface `writePointFrameUniform` + `pointWorldCopies` read. Only reached
 *  when a compiled layer is resident (an empty manager early-returns first), so the DPR
 *  test needs it and the retirement tests do not. */
const stubCamera = {
  effectiveMpp: () => 1,
  getMercatorCenter: () => ({ x: 0, y: 0 }),
  getECEFCenter: () => [0, 0, 0],
  getVisibleWorldCopies: () => [0],
} as unknown as Camera

/** A recording render pass — the surface `executeItems` drives. Inert apart from
 *  counting, so a resident compiled layer can be rendered without a GPU. */
function stubPass() {
  return {
    draws: 0,
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed(this: { draws: number }) {
      this.draws++
    },
    draw(this: { draws: number }) {
      this.draws++
    },
  }
}

/** A render at the given DPR — drains `_retired` and applies the DPR re-pack. */
function render(gm: GraphicsManager, dpr = 1, pass: object = stubPass()): void {
  gm.renderRetained(
    pass as never,
    { matrix: new Float32Array(16), logDepthFc: 0.03 },
    stubCamera,
    0,
    0,
    0,
    800,
    600,
    dpr,
  )
}

function addLayer(gm: GraphicsManager, n: number, strokeUnits = 0): void {
  gm.addCompiledArrowLayer(
    Float64Array.from({ length: n }, (_, i) => -70 + i),
    Float64Array.from({ length: n }, (_, i) => 40 + i * 0.1),
    Float32Array.from({ length: n }, (_, i) => (i * 37) % 360),
    Float32Array.from({ length: n }, () => 12),
    Array.from({ length: n }, () => [1, 0, 0, 1] as const),
    strokeUnits,
  )
}

const compiledBufs = (created: StubBuf[]): StubBuf[] =>
  created.filter((b) => b.label?.startsWith('compiled-arrow') === true)

describe('compiled `| arrow` layer store (#1302 / #1333)', () => {
  it('a layer added BEFORE a device is silently dropped (no buffers, no throw)', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    addLayer(gm, 4)
    expect(s.created).toHaveLength(0)
    // ...and the pass gate stays off, so a device-less map runs no graphics pass.
    expect(gm.hasRetainedBatches()).toBe(false)
  })

  it('an EMPTY layer creates nothing (count 0 short-circuits before createBuffer)', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 0)
    expect(compiledBufs(s.created)).toHaveLength(0)
    expect(gm.hasRetainedBatches()).toBe(false)
  })

  it('add() creates exactly one feat + one tint buffer and flips the pass gate', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    expect(gm.hasRetainedBatches()).toBe(false)
    addLayer(gm, 8)
    const bufs = compiledBufs(s.created)
    expect(bufs.map((b) => b.label)).toEqual(['compiled-arrow-feat', 'compiled-arrow-tint'])
    // A compiled layer alone (no host batch) MUST run the graphics pass.
    expect(gm.hasRetainedBatches()).toBe(true)
  })

  it('add() bumps BOTH write counters — the store counters are folded into the manager', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    const before = gm.getWriteCounts()
    addLayer(gm, 8)
    const after = gm.getWriteCounts()
    expect(after.featWrites - before.featWrites).toBe(1)
    expect(after.tintWrites - before.tintWrites).toBe(1)
  })

  it('clear() RETIRES the buffers — destroyed only on the NEXT render, never inline', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    const bufs = compiledBufs(s.created)
    gm.clearCompiledArrows()
    // Inline destroy would free a buffer an in-flight submit may still have bound.
    expect(s.destroyed).toHaveLength(0)
    // The pass gate stays ON while retired buffers are pending, so the drain runs.
    expect(gm.hasRetainedBatches()).toBe(true)
    render(gm)
    expect(s.destroyed).toEqual(bufs)
    expect(gm.hasRetainedBatches()).toBe(false)
  })

  it('a DPR change re-packs every layer feat from the retained raw arrays (tint untouched)', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    addLayer(gm, 3)
    const before = gm.getWriteCounts()
    render(gm, 2)
    const after = gm.getWriteCounts()
    // One feat re-pack per layer; sizes are baked in px so tint is DPR-independent.
    expect(after.featWrites - before.featWrites).toBe(2)
    expect(after.tintWrites - before.tintWrites).toBe(0)
    // An unchanged DPR re-packs nothing.
    const again = gm.getWriteCounts()
    render(gm, 2)
    expect(gm.getWriteCounts()).toEqual(again)
  })

  it('each resident layer issues one instanced draw per world copy, N-independently', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    const pass = stubPass()
    render(gm, 1, pass)
    // One copy (the stub camera reports [0]) × one layer.
    expect(pass.draws).toBe(1)
    expect(gm.getLastFrameDrawCalls()).toBe(1)
    // A 100× bigger layer draws the SAME number of calls — the N-independence invariant.
    gm.clearCompiledArrows()
    addLayer(gm, 800)
    const pass2 = stubPass()
    render(gm, 1, pass2)
    expect(pass2.draws).toBe(1)
    // A second layer adds exactly one more.
    addLayer(gm, 8)
    const pass3 = stubPass()
    render(gm, 1, pass3)
    expect(pass3.draws).toBe(2)
  })

  it('destroyGpu() frees every layer buffer and empties the store', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    addLayer(gm, 3)
    const bufs = compiledBufs(s.created)
    expect(bufs).toHaveLength(4)
    gm.destroyGpu()
    expect(s.destroyed).toEqual(expect.arrayContaining(bufs))
    expect(gm.hasRetainedBatches()).toBe(false)
    // The store dropped its device with the records: a post-destroy add is a no-op,
    // not a write into a freed device.
    const createdBefore = s.created.length
    addLayer(gm, 4)
    expect(s.created).toHaveLength(createdBefore)
  })

  it('a re-attach after destroyGpu accepts layers again (scene swap)', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    gm.destroyGpu()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 8)
    expect(gm.hasRetainedBatches()).toBe(true)
  })
})

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
    // The draper's source seam (wgslFor / glslStagesFor) reads this to decide which
    // shader language to EMIT. 'wgsl' keeps the stub cheap: the GLSL twins are skipped,
    // so these tests exercise buffer/bind-group bookkeeping without paying a real emit.
    caps: { shaderLanguage: 'wgsl' },
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

function addLayer(gm: GraphicsManager, n: number, strokeUnits = 0, region = ''): void {
  gm.addCompiledArrowLayer(
    Float64Array.from({ length: n }, (_, i) => -70 + i),
    Float64Array.from({ length: n }, (_, i) => 40 + i * 0.1),
    Float32Array.from({ length: n }, (_, i) => (i * 37) % 360),
    Float32Array.from({ length: n }, () => 12),
    Array.from({ length: n }, () => [1, 0, 0, 1] as const),
    strokeUnits,
    region,
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

  // #1272 E-④ — a mosaic keeps one arrow layer PER NOAA domain. The unscoped clear ran on
  // every single-region re-arm, so a neighbour's forecast step wiped every other domain's
  // glyphs and re-added only its own: with the drape already multi-region, the arrows were
  // the remaining reason only one domain was ever visible.
  it('a region-scoped clear() drops ONLY that region, leaving its neighbours resident', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 4, 0, 'cbofs')
    addLayer(gm, 4, 0, 'dbofs')
    const [cbofsFeat, cbofsTint, dbofsFeat, dbofsTint] = compiledBufs(s.created)

    gm.clearCompiledArrows('cbofs')
    render(gm)
    expect(s.destroyed).toEqual([cbofsFeat, cbofsTint]) // dbofs untouched
    // The neighbour still draws — the whole point. One instanced draw per world copy.
    expect(gm.hasRetainedBatches()).toBe(true)

    // …and the unscoped clear still means EVERY region (the rebuildLayers lifecycle).
    gm.clearCompiledArrows()
    render(gm)
    expect(s.destroyed).toEqual([cbofsFeat, cbofsTint, dbofsFeat, dbofsTint])
    expect(gm.hasRetainedBatches()).toBe(false)
  })

  it('clearing an UNKNOWN region drops nothing (a region that never armed is not an error)', () => {
    const gm = new GraphicsManager()
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    addLayer(gm, 4, 0, 'cbofs')
    gm.clearCompiledArrows('sfbofs')
    render(gm)
    expect(s.destroyed).toEqual([])
    expect(gm.hasRetainedBatches()).toBe(true)
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

// ── ADVECTED batches (#1419) ─────────────────────────────────────────────────────────────
//
// The particle portrayal shares this store's lifecycle but not its resources: it uploads a band
// table instead of a tint buffer, and its bind group also binds the arrow ping-pong's READ side,
// which alternates every step. Both differences are invisible in a frame — an advected batch
// drawn with a stale group animates perfectly and reports the wrong instant — so they are pinned
// here, through the same public surface the static cases use.

function makeArrowSource() {
  const a = { native: 'state-a' } as never
  const b = { native: 'state-b' } as never
  const origin = { native: 'origin' } as never
  const originWrites: string[] = []
  const released: string[] = []
  let flipped = false
  let field = { u: { native: 'u' } as never, v: { native: 'v' } as never }
  return {
    originWrites,
    released,
    swap: () => {
      flipped = !flipped
    },
    /** A different coverage region's velocity pair — what a mosaic eviction leaves behind. */
    rearmField: () => {
      field = { u: { native: 'u2' } as never, v: { native: 'v2' } as never }
    },
    source: {
      releaseArrowOrigins: (key: string) => void released.push(key),
      writeArrowOrigins: (key: string) => {
        originWrites.push(key)
        return 0 // single-region fixtures: every batch is based at texel 0
      },
      // Single-region fixtures: one field, whatever region is asked for. The PER-REGION
      // contract is pinned where it can actually be observed — two real regions against a real
      // FlowRenderer, in render/arrow-field-per-region.test.ts (#1458).
      arrowBindingFor: () => ({ state: flipped ? b : a, origin, flowU: field.u, flowV: field.v }),
    },
  }
}

function addAdvected(gm: GraphicsManager, n: number, region = ''): void {
  gm.addCompiledArrowLayer(
    Float64Array.from({ length: n }, (_, i) => -70 + i),
    Float64Array.from({ length: n }, (_, i) => 40 + i * 0.1),
    Float32Array.from({ length: n }, () => 0),
    Float32Array.from({ length: n }, () => 34),
    Array.from({ length: n }, () => [1, 0, 0, 1] as const),
    0.06,
    region,
    {
      originU: Float32Array.from({ length: n }, (_, i) => i / n),
      originV: Float32Array.from({ length: n }, () => 0.5),
      uStepLon: Float64Array.from({ length: n }, (_, i) => -70 + i + 0.1),
      uStepLat: Float64Array.from({ length: n }, (_, i) => 40 + i * 0.1),
      vStepLon: Float64Array.from({ length: n }, (_, i) => -70 + i),
      vStepLat: Float64Array.from({ length: n }, (_, i) => 40 + i * 0.1 - 0.1),
      bandTable: new Float32Array(80),
    },
  )
}

describe('CompiledArrowStore — advected batches (#1419)', () => {
  it('uploads a BAND table and no tint — there is no launch colour to keep', () => {
    const t = makeStubs()
    const gm = new GraphicsManager()
    const arrows = makeArrowSource()
    gm.setAdvectedArrowSource(arrows.source)
    gm.attachDevice(t.device as never, t.rhi as never, 'bgra8unorm' as never)
    addAdvected(gm, 4)
    const labels = compiledBufs(t.created).map((b) => b.label)
    expect(labels).toContain('compiled-arrow-feat')
    expect(labels).toContain('compiled-arrow-band')
    expect(labels).not.toContain('compiled-arrow-tint')
  })

  it('carries the origins in the FEAT buffer — no separate upload, no shared state (#1520)', () => {
    // There used to be a second upload here, of one texel per arrow into a state texture the
    // whole map shared, and it had to happen at ADD time because the advect pass ran earlier in
    // the frame than the graphics pass. Both are gone: the origin rides the instance record and
    // the position is a function of it, so the batch is complete the moment its feat buffer is.
    const t = makeStubs()
    const gm = new GraphicsManager()
    gm.setAdvectedArrowSource(makeArrowSource().source)
    gm.attachDevice(t.device as never, t.rhi as never, 'bgra8unorm' as never)
    addAdvected(gm, 4)
    // feat + band, and nothing else — in particular no per-arrow state allocation.
    expect(compiledBufs(t.created).length).toBe(2)
  })

  it('DROPS an advected batch when no arrow source is attached', () => {
    // The alternative — falling back to the static draper — is a field that animates nothing
    // and reports its launch instant forever, which looks like a working portrayal.
    const t = makeStubs()
    const gm = new GraphicsManager()
    gm.attachDevice(t.device as never, t.rhi as never, 'bgra8unorm' as never)
    addAdvected(gm, 4)
    expect(compiledBufs(t.created)).toHaveLength(0)
  })

  it('builds ONE bind group and keeps it — there is no ping-pong left to alternate (#1520)', () => {
    // It used to need one group per state side, rebuilt as the pair swapped every step. With no
    // state there is nothing to alternate, so a steady camera rebuilds nothing at all.
    const t = makeStubs()
    const gm = new GraphicsManager()
    gm.setAdvectedArrowSource(makeArrowSource().source)
    gm.attachDevice(t.device as never, t.rhi as never, 'bgra8unorm' as never)
    let groups = 0
    t.rhi.createBindGroup = () => {
      groups++
      return {}
    }
    addAdvected(gm, 4)
    const during = (fn: () => void): number => {
      const before = groups
      fn()
      return groups - before
    }
    expect(
      during(() => render(gm)),
      'first draw builds it',
    ).toBeGreaterThan(0)
    expect(
      during(() => render(gm)),
      'a second draw rebuilds nothing',
    ).toBe(0)
    expect(
      during(() => render(gm)),
      'and a third',
    ).toBe(0)
  })
  it('retires the band buffer with the rest when the layer is cleared', () => {
    const t = makeStubs()
    const gm = new GraphicsManager()
    const arrows = makeArrowSource()
    gm.setAdvectedArrowSource(arrows.source)
    gm.attachDevice(t.device as never, t.rhi as never, 'bgra8unorm' as never)
    addAdvected(gm, 4)
    gm.clearCompiledArrows()
    render(gm)
    const freed = t.destroyed.map((b) => b.label)
    expect(freed).toContain('compiled-arrow-feat')
    expect(freed).toContain('compiled-arrow-band')
  })
})

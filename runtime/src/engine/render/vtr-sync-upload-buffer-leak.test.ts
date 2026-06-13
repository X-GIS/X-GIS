// Leak gate for the SYNC upload path (`doUploadTile`) buffer cleanup.
//
// THE BUG THIS PINS: in `doUploadTile`, the line / outline / segment
// GPUBuffers (lineVertexBuffer, lineIndexBuffer, outlineIndexBuffer,
// outlineSegmentBuffer, lineSegmentBuffer) used to be declared INSIDE
// the outer try block. The catch backstop freed ONLY the polygon arena
// slots (polyVertexOffset / polyIndexOffset, hoisted above the try).
// So a synchronous throw landing AFTER those buffers were acquired but
// BEFORE `layerCache.set` (e.g. a writeBuffer / uploadSegmentBuffer /
// createLayerBindGroup device-loss or validation error) orphaned the
// pooled line/index buffers + the lineRenderer-owned segment buffers:
// never recorded in the cache, never released → VRAM leak.
//
// THE FIX (mirror of the async path's `cleanupLineBuffers`): the 5
// buffers are hoisted ABOVE the sync try, and the catch now releases
// the pooled vertex/index buffers + destroys the segment buffers —
// exactly the primitives `_releaseTileSlots` uses on normal eviction.
//
// HOW THIS TEST WORKS: VTR's constructor needs a real GPU device which
// can't run in vitest, so we build the instance with Object.create +
// manual field injection (the same escape hatch vtr-pump-prefetch.test.ts
// uses). We inject a mock `_store` whose acquireBuffer returns tracked
// fake buffers + whose poly arenas are roomy stubs, a `lineRenderer`
// whose SECOND createLayerBindGroup throws (so all 5 line/segment
// buffers are populated when the throw lands), and the few collaborators
// the sync path touches. Then we call the private `doUploadTile` and
// assert every acquired buffer was returned to the pool / destroyed and
// the poly slots were freed — i.e. nothing leaked.

import { beforeAll, describe, expect, it } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'
import type { TileData } from '../../data/tile-types'

// vitest runs in Node, where the WebGPU `GPUBufferUsage` global doesn't
// exist. doUploadTile references it when computing buffer usage flags
// (e.g. `GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST`), so we shim the
// bit constants the upload path uses before exercising the code. Values
// match the WebGPU spec.
beforeAll(() => {
  if (typeof (globalThis as Record<string, unknown>).GPUBufferUsage === 'undefined') {
    ;(globalThis as Record<string, unknown>).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
      INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    }
  }
})

interface TrackedBuffer {
  kind: 'pooled' | 'segment'
  label?: string
  released: boolean
  destroyed: boolean
  size: number
  usage: number
  destroy(): void
}

function makeTrackedBuffer(kind: 'pooled' | 'segment', label?: string): TrackedBuffer {
  const b: TrackedBuffer = {
    kind,
    label,
    released: false,
    destroyed: false,
    size: 256,
    usage: 0,
    destroy() { b.destroyed = true },
  }
  return b
}

// Minimal poly arena stub: alloc bumps an offset, free records the call.
// Roomy enough that the Lane-B alloc-fail path never fires, so the test
// exercises the line/segment leak path specifically.
function makeArenaStub() {
  let bump = 0
  const freed: Array<{ off: number; bytes: number }> = []
  const buffer = makeTrackedBuffer('pooled', 'poly-arena') as unknown as GPUBuffer
  return {
    buffer,
    freed,
    alloc(bytes: number): number { const off = bump; bump += Math.max(bytes, 4); return off },
    free(off: number, bytes: number): void { freed.push({ off, bytes }) },
  }
}

function makeTileData(): TileData {
  // Non-empty line + outline so every buffer branch is taken:
  //   lineVertices/lineIndices  → lineVertexBuffer + lineIndexBuffer + lineSegmentBuffer
  //   outlineIndices            → outlineIndexBuffer
  //   outlineVertices/Line      → outlineSegmentBuffer
  return {
    vertices: new Float32Array([0, 0, 0, 0, 0, 0]),
    dequantScale: 1,
    dequantHalf: 0,
    indices: new Uint32Array([0, 1, 2]),
    lineVertices: new Float32Array(20),   // 2 verts × stride 10
    lineIndices: new Uint32Array([0, 1]),
    outlineIndices: new Uint32Array([0, 1]),
    outlineVertices: new Float32Array(20),
    outlineLineIndices: new Uint32Array([0, 1]),
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 1,
    tileHeight: 1,
    tileZoom: 14,
  }
}

// Build a VTR with just the fields doUploadTile reads, wiring a
// lineRenderer whose second createLayerBindGroup throws (device-loss/
// validation simulation) so the throw lands AFTER all 5 line/segment
// buffers are acquired but BEFORE layerCache.set.
function makeVtr() {
  const acquired: TrackedBuffer[] = []
  const released: TrackedBuffer[] = []
  const segmentBuffers: TrackedBuffer[] = []
  const vArena = makeArenaStub()
  const iArena = makeArenaStub()
  const layerCache = new Map<number, unknown>()

  const store = {
    getOrCreateLayer: () => layerCache,
    polyVertexArenaOrCreate: () => vArena,
    polyIndexArenaOrCreate: () => iArena,
    polyVertexArenaOrNull: () => vArena,
    polyIndexArenaOrNull: () => iArena,
    acquireBuffer(_size: number, usage: number, label: string): GPUBuffer {
      const b = makeTrackedBuffer('pooled', label)
      b.usage = usage
      acquired.push(b)
      return b as unknown as GPUBuffer
    },
    releaseBuffer(buf: GPUBuffer | null | undefined): void {
      if (!buf) return
      const b = buf as unknown as TrackedBuffer
      b.released = true
      released.push(b)
    },
    nextUploadEpoch: () => 1,
    incrementCount: () => {},
    forceEvictBytes: () => {},
  }

  let bindGroupCalls = 0
  const lineRenderer = {
    uploadSegmentBuffer(_seg: Float32Array): GPUBuffer {
      const b = makeTrackedBuffer('segment', 'line-segments')
      segmentBuffers.push(b)
      return b as unknown as GPUBuffer
    },
    createLayerBindGroup(_buf: GPUBuffer): GPUBindGroup {
      bindGroupCalls++
      // First call (outline) succeeds; second call (line) throws — by
      // then outlineSegmentBuffer + lineSegmentBuffer are both acquired,
      // and the 3 pooled line/index buffers were acquired earlier.
      if (bindGroupCalls >= 2) throw new Error('simulated device-loss in createLayerBindGroup')
      return {} as GPUBindGroup
    },
  }

  const drawStats = {
    hasWarned: () => false,
    markWarned: () => {},
  }

  const device = {
    queue: { writeBuffer: () => {} },
  }

  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const inj = vtr as unknown as Record<string, unknown>
  inj._store = store
  inj.device = device
  inj.lineRenderer = lineRenderer
  inj._drawStats = drawStats
  inj.frameCount = 0
  inj.stableKeys = new Set<number>()
  inj._releaseTileHook = () => {}

  return { vtr, acquired, released, segmentBuffers, vArena, iArena, layerCache }
}

describe('doUploadTile (sync path) — line/outline/segment buffer leak on mid-upload throw', () => {
  it('frees the pooled line/index buffers AND destroys the segment buffers when a throw lands before layerCache.set', () => {
    const ctx = makeVtr()
    const data = makeTileData()

    // Call the private sync upload. The injected lineRenderer throws on
    // the 2nd createLayerBindGroup, so layerCache.set never runs and the
    // outer catch backstop is the only code that can free the buffers.
    expect(() => {
      ;(ctx.vtr as unknown as { doUploadTile(k: number, d: TileData, s?: string): void })
        .doUploadTile(1, data, '')
    }).not.toThrow()  // the catch degrades the throw to skip-this-tile

    // The tile was NOT cached (throw before set).
    expect(ctx.layerCache.has(1)).toBe(false)

    // Exactly 3 pooled buffers were acquired (lineVertex, lineIndex,
    // outlineIndex) and exactly 2 segment buffers were created.
    expect(ctx.acquired.length).toBe(3)
    expect(ctx.segmentBuffers.length).toBe(2)

    // FIX ASSERTION: every acquired pooled buffer must be released
    // (returned to the pool) and every segment buffer destroyed. Before
    // the fix the catch freed only the poly arena slots, so these stay
    // false and this assertion fails.
    for (const b of ctx.acquired) {
      expect(b.released, `pooled buffer ${b.label} must be releaseBuffer'd in the catch`).toBe(true)
    }
    for (const b of ctx.segmentBuffers) {
      expect(b.destroyed, `segment buffer ${b.label} must be .destroy()'d in the catch`).toBe(true)
    }

    // The poly arena slots claimed before the throw were also freed
    // (pre-existing behaviour, asserted to guard against regression).
    expect(ctx.vArena.freed.length).toBe(1)
    expect(ctx.iArena.freed.length).toBe(1)
  })

  it('does NOT double-free on the happy path: a successful upload caches the buffers and the catch never runs', () => {
    const ctx = makeVtr()
    const data = makeTileData()
    // Patch the lineRenderer so NO createLayerBindGroup throws — the
    // upload completes and layerCache.set records the buffers.
    ;(ctx.vtr as unknown as { lineRenderer: { createLayerBindGroup(b: GPUBuffer): GPUBindGroup } })
      .lineRenderer.createLayerBindGroup = () => ({} as GPUBindGroup)
    // Inject the collaborators the happy path reaches AFTER bind-group
    // creation (perTileFeat builder + uniform ring + bind-group palette).
    const inj = ctx.vtr as unknown as Record<string, unknown>
    inj._featureBinder = { buildPerTileFeatureData: () => null }
    inj.uniformRing = { buffer: {} }
    inj._bindGroups = { paletteResources: () => ({}) }

    ;(ctx.vtr as unknown as { doUploadTile(k: number, d: TileData, s?: string): void })
      .doUploadTile(2, data, '')

    // Happy path: tile cached, nothing released/destroyed by a catch,
    // poly slots NOT freed (owned by the cache entry now).
    expect(ctx.layerCache.has(2)).toBe(true)
    for (const b of ctx.acquired) expect(b.released).toBe(false)
    for (const b of ctx.segmentBuffers) expect(b.destroyed).toBe(false)
    expect(ctx.vArena.freed.length).toBe(0)
    expect(ctx.iArena.freed.length).toBe(0)
  })
})

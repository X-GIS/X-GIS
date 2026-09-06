// ═══ #2024 — globe drape virtual-overzoom windowed bakes ═══
//
// Past the source maxLevel the tile selection re-renders maxLevel tiles
// "camera-magnified". The direct vector path magnifies GEOMETRY (sharp at any
// depth); the drape used to magnify a fixed 512px BAKE (2^Δz blur — the
// "low-res past the source max" report). The fix drapes VIRTUAL sub-tiles,
// each a 512px bake of its maxLevel ancestor seen through a WINDOWED tile-local
// ortho. These tests pin the window math and the atomic parent→virtual switch
// with the same mock-RHI harness as the #1142 aliasing test (GPU-free).

import { describe, it, expect } from 'vitest'
import {
  VectorDrapeRenderer,
  type BakeWindow,
  type DrapeBakeProvider,
  type DrapeOverzoomTile,
} from './vector-drape-renderer'
import type { GPUTile } from './vector-tile-renderer-types'
import { tileKey } from '@xgis/compiler'
import { EARTH } from '@xgis/shared'

interface MockBuf {
  __id: number
  __bytes: Uint8Array | null
}

function makeMockRhi() {
  let id = 0
  return {
    backend: 'webgpu' as const,
    caps: { shaderLanguage: 'wgsl' },
    createBindGroupLayout: () => ({ __layout: true }),
    createPipeline: () => ({ __pipe: true }),
    createSampler: () => ({ __sampler: true }),
    createBuffer: (_d: { size: number; usage: string }): MockBuf => ({ __id: ++id, __bytes: null }),
    createTexture: (d: { label?: string }) => ({ __tex: true, label: d.label ?? '' }),
    createView: () => ({ __view: true }),
    // #2539 — RasterDraper initialises a 1x1 DEM stub on its first draw (the
    // group-0 binding the shared `vs_tile` reads elevation from must be filled
    // even with no terrain). A double that omits this is not a passing test, it
    // is `TypeError: this.rhi.writeTexture is not a function` inside draw — the
    // hazard is that the cast to RhiDevice hides it from tsc entirely, so the
    // whole suite compiles green and dies at run time (CLAUDE.md §12).
    writeTexture: () => {},
    createBindGroup: (_layout: unknown, entries: { resource?: { buffer?: MockBuf } }[]) => ({
      __bg: true,
      buffer: entries[0]?.resource?.buffer ?? null,
    }),
    writeBuffer: (buf: MockBuf, _off: number, data: BufferSource) => {
      const src =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength,
            )
      buf.__bytes = src.slice()
    },
    destroyTexture: () => {},
  }
}

function makeMockPass(poolGroup: number) {
  const draws: Array<Uint8Array | null> = []
  let curPool: MockBuf | null = null
  const pass = {
    setPipeline: () => {},
    setBindGroup: (group: number, bg: { buffer?: MockBuf } | null) => {
      if (group === poolGroup) curPool = bg?.buffer ?? null
    },
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    draw: () => draws.push(curPool?.__bytes ? curPool.__bytes.slice() : null),
    drawIndexed: () => draws.push(curPool?.__bytes ? curPool.__bytes.slice() : null),
  }
  return { pass, draws }
}

/** Parent GPUTile z1 x=1 y=0 — lon [0, 180], lat [0, 85.051129]. */
function parentTile(): GPUTile {
  return {
    extruded: false,
    uploadEpoch: 1,
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 180,
    tileHeight: 85.051129,
    tileZoom: 1,
  } as unknown as GPUTile
}

const SPHERE_R = EARTH.sphereR
const PARENT_E = (2 * Math.PI * SPHERE_R) / 2 // z1 tile-local Mercator extent (m)
const PARENT_KEY = tileKey(1, 1, 0)
const FRAME = { matrix: new Float32Array(16), logDepthFc: 1 }
const FILL: [number, number, number, number] = [0.5, 0.5, 0.5, 1]
const CAMERA = { centerX: 0, centerY: 0 }

function makeDrape(): {
  drape: VectorDrapeRenderer
  pass: ReturnType<typeof makeMockPass>['pass']
  draws: Array<Uint8Array | null>
  windows: Array<BakeWindow | undefined>
  bakes: number
} {
  const rhi = makeMockRhi()
  const drape = new VectorDrapeRenderer(
    rhi as unknown as ConstructorParameters<typeof VectorDrapeRenderer>[0],
    'rgba8unorm',
    1,
  )
  const { pass, draws } = makeMockPass(1)
  const state = { drape, pass, draws, windows: [] as Array<BakeWindow | undefined>, bakes: 0 }
  return state
}

function providerFor(state: { windows: Array<BakeWindow | undefined>; bakes: number }): {
  provider: DrapeBakeProvider
  counters: typeof state
} {
  const provider: DrapeBakeProvider = {
    bakeTileToTexture: (sliceLayer, key, _fill, _sizePx, _sws, window) => {
      state.windows.push(window)
      state.bakes++
      return { __rhiBake: true, label: `vtr-bake-${sliceLayer}-${key}` } as never
    },
  }
  return { provider, counters: state }
}

function renderOverzoom(
  state: ReturnType<typeof makeDrape>,
  provider: DrapeBakeProvider,
  overzoom: DrapeOverzoomTile[],
  camZoom = 3,
): void {
  const layer = new Map<number, GPUTile>([[PARENT_KEY, parentTile()]])
  state.drape.beginFrame()
  state.drape.renderGlobeFills(
    state.pass as never,
    FRAME,
    7,
    0,
    0,
    CAMERA,
    1,
    FILL,
    0,
    camZoom,
    'land',
    [PARENT_KEY], // neededKeys — must be IGNORED when overzoom is present
    undefined,
    layer,
    provider,
    overzoom,
  )
}

describe('globe drape virtual overzoom (#2024)', () => {
  it('bakes each virtual tile through the exact parent-local window', () => {
    const state = makeDrape()
    const { provider } = providerFor(state)
    // z3 children of z1 (1,0): x ∈ [4..7], y ∈ [0..3]. Δz = 2 → Es = E/4.
    renderOverzoom(state, provider, [
      { z: 3, x: 4, y: 0, parentKey: PARENT_KEY }, // NW corner child: rx=0, ry=0
      { z: 3, x: 7, y: 3, parentKey: PARENT_KEY }, // SE corner child: rx=3, ry=3
    ])
    const es = PARENT_E / 4
    expect(state.windows).toHaveLength(2)
    // Window extents are exact powers-of-two divisions of the parent extent.
    expect(state.windows[0]!.extent).toBe(es)
    expect(state.windows[1]!.extent).toBe(es)
    // NW child: west edge shared with the parent (ox = 0); its SOUTH edge sits
    // 3 sub-rows up the parent's local-merc frame (oy = E − Es).
    expect(state.windows[0]!.ox).toBeCloseTo(0, 6)
    expect(state.windows[0]!.oy).toBeCloseTo(PARENT_E - es, 3)
    // SE child: 3 sub-columns east (ox = 3·Es); south edge = parent south (oy = 0).
    expect(state.windows[1]!.ox).toBeCloseTo(3 * es, 3)
    expect(state.windows[1]!.oy).toBeCloseTo(0, 3)
  })

  it('draws the VIRTUAL bounds — not the parent bounds — and ignores neededKeys', () => {
    const state = makeDrape()
    const { provider } = providerFor(state)
    renderOverzoom(state, provider, [{ z: 3, x: 4, y: 0, parentKey: PARENT_KEY }])
    // One draw per virtual tile (neededKeys would ALSO have drawn 1 parent tile —
    // both covers at once would double-blend translucent fills).
    expect(state.draws).toHaveLength(1)
    const bytes = state.draws[0]!
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    // RASTER_TILE_U leads with bounds = [west, south, east, north]; the z3 x=4
    // child of z1 x=1 spans lon [0, 45]; its north edge is the z3 row-0 top.
    expect(f[0]).toBeCloseTo(0, 4)
    expect(f[2]).toBeCloseTo(45, 4)
    expect(f[3]).toBeCloseTo(85.051129, 3)
    // south = z3 row-1 boundary lat: atan(sinh(π·(1 − 2/8))) in degrees.
    const expectedSouth = (Math.atan(Math.sinh(Math.PI * 0.75)) * 180) / Math.PI
    expect(f[1]).toBeCloseTo(expectedSouth, 3)
  })

  it('re-uses a virtual bake across frames (cache key includes the virtual coord)', () => {
    const state = makeDrape()
    const { provider, counters } = providerFor(state)
    const vt: DrapeOverzoomTile[] = [{ z: 3, x: 5, y: 1, parentKey: PARENT_KEY }]
    renderOverzoom(state, provider, vt)
    renderOverzoom(state, provider, vt)
    expect(counters.bakes).toBe(1)
    expect(state.draws).toHaveLength(2)
  })
})

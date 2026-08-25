// #1984 (ADR-0012 Phase B3) — a source-level `bounds` DECLARED in an `.xgis` source
// block must reach the raster / raster-dem request path and actually stop the requests
// that fall outside it.
//
// The vector family has clipped since PMTilesBackend shipped: `tileIntersectsBounds`
// (data/sources/pmtiles-backend-helpers.ts) gates `hasTile` from the ARCHIVE's own
// header / TileJSON-manifest bounds. The raster family had no equivalent — the frustum
// selector is global, so a regional source got ocean-tile requests that can only 404,
// every frame, against the same fixed concurrency budget the visible tiles need.
//
// Wired here, mirroring #1983's maxzoom hops:
//   1. `SourceManager._attachOneSource` puts `bounds` on both tile markers.
//   2. `map.ts` hands the raster marker's bounds to `RasterRenderer.setSourceBounds`;
//      the DEM marker's goes through `armHillshadeSource` → `setParams` (whose merge
//      must carry the key, the exact hop that swallowed maxzoom in #1983).
//   3. Both `render()` bodies filter the selector's tile list through the ONE shared
//      predicate — `clipTilesToBounds` over `tileIntersectsBounds`.
//
// The clip's load-bearing case is the CONTAINING tile: a low-zoom parent covers the
// whole box, so a naive "is the tile inside the box" test throws away exactly the
// coarse tiles the fallback ladder draws first, and the source appears blank until the
// leaves arrive. `tileIntersectsBounds` is an overlap test, not a containment test —
// pinned below in both directions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { SourceManager } from './source-manager'
import { InputStore } from './render/input-store'
import { HillshadeRenderer, armHillshadeSource } from './render/hillshade-renderer'
import { RasterRenderer } from './render/raster-renderer'
import { clipTilesToBounds, normalizeSourceBounds } from './render/source-bounds-clip'
import { Camera } from './camera'
import type { RawDataset } from './map-types'
import type { SceneCommands } from './interpreter'
import type { GeoJSONFeatureCollection, CapPoles } from '@xgis/data'

/** Western-Mediterranean box: Iberia + the Gulf of Lion. Straddles the prime meridian,
 *  so at z2 it overlaps exactly two tiles (x=1 and x=2 of row y=1). */
const MED: [number, number, number, number] = [-10, 35, 5, 45]

// ─────────────────────────────────────────────────────────────────────────────
// Hop 1 — the source-manager markers carry the declared bounds
// ─────────────────────────────────────────────────────────────────────────────

function makeManager() {
  const rawDatasets = new Map<string, RawDataset>()
  const mgr = new SourceManager({
    rawDatasets,
    inputs: new InputStore(),
    registerVtSource: () => {},
    sourceCRS: new Map<string, string>(),
    geojsonCapPoles: new Map<string, CapPoles>(),
    heatmapPointData: new Map<string, GeoJSONFeatureCollection>(),
    camera: {} as never,
    getCanvas: () => ({ width: 800 }) as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate: () => {},
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => {},
    teardownSource: () => {},
    fireError: () => {},
    getVtSource: () => null,
    hasVariantSources: () => false,
    deleteFeatureIndex: () => {},
    beginCoverageLoad: () => Promise.resolve(),
  })
  return { mgr, rawDatasets }
}

const load = (over: Partial<SceneCommands['loads'][0]>): SceneCommands['loads'][0] => ({
  name: 'src',
  url: 'https://x/{z}/{x}/{y}.png',
  ...over,
})

const attach = async (l: SceneCommands['loads'][0]) => {
  const { mgr, rawDatasets } = makeManager()
  await mgr._attachOneSource(l, '', {} as never, { fit: false })
  return rawDatasets.get(l.name)
}

describe('#1984 hop 1 — the source-manager markers carry the declared bounds', () => {
  it('raster: the `{ _tileUrl }` marker carries bounds alongside tileSize / maxzoom', async () => {
    const marker = await attach(load({ type: 'raster', tileSize: 256, maxzoom: 6, bounds: MED }))
    expect(marker).toMatchObject({ _tileUrl: 'https://x/{z}/{x}/{y}.png', bounds: MED })
  })

  it('raster-dem: the `_dem` marker carries bounds alongside the DEM decode', async () => {
    const marker = await attach(
      load({ name: 'dem', type: 'raster-dem', encoding: 'terrarium', bounds: MED }),
    )
    expect(marker).toMatchObject({ _dem: true, encoding: 'terrarium', bounds: MED })
  })

  it('a source that declares no bounds leaves it undefined — unclipped, as before', async () => {
    const marker = (await attach(load({ type: 'raster' }))) as { bounds?: unknown }
    expect(marker.bounds).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hop 2 — HillshadeRenderer.setParams keeps bounds through the merge
// ─────────────────────────────────────────────────────────────────────────────

describe('#1984 hop 2 — the DEM arm survives the setParams merge', () => {
  const renderer = () => new HillshadeRenderer({ rhi: {}, format: 'bgra8unorm' } as never)
  const paramsOf = (r: HillshadeRenderer) =>
    (r as unknown as { _params: { bounds?: [number, number, number, number] } })._params

  it('armHillshadeSource → setParams: the DEM marker bounds survive', () => {
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png', bounds: MED })
    expect(paramsOf(r).bounds).toEqual(MED)
  })

  it('a later PAINT-only merge does not clobber the armed bounds', () => {
    // The exact hop that swallowed #1983's maxzoom: the arm and the per-frame paint
    // merge into the SAME object, and a paint merge names none of the source keys.
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png', bounds: MED })
    r.setParams({ direction: 300, altitude: 30 })
    expect(paramsOf(r).bounds).toEqual(MED)
  })

  it('an un-declaring source leaves bounds undefined (unclipped)', () => {
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png' })
    expect(paramsOf(r).bounds).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hop 3 — the clip predicate itself (the semantics table)
// ─────────────────────────────────────────────────────────────────────────────

describe('#1984 hop 3 — clip semantics: outside drops, intersecting AND containing stay', () => {
  const t = (z: number, x: number, y: number) => ({ z, x, y })
  const kept = (tiles: ReturnType<typeof t>[], b = MED) =>
    clipTilesToBounds(tiles, b).map((c) => `${c.z}/${c.x}/${c.y}`)

  it('OUTSIDE — a z2 tile with no overlap is dropped', () => {
    // 2/0/0 = lon [-180,-90] × lat [66.5,85.1]; 2/3/3 = lon [90,180] × lat [-85.1,-66.5];
    // 2/1/2 = lon [-90,0] but the SOUTHERN hemisphere, so it shares longitude only.
    expect(kept([t(2, 0, 0), t(2, 3, 3), t(2, 1, 2)])).toEqual([])
  })

  it('INTERSECTING — the two z2 tiles the box straddles are kept', () => {
    expect(kept([t(2, 1, 1), t(2, 2, 1)])).toEqual(['2/1/1', '2/2/1'])
  })

  it('CONTAINING — a parent tile that swallows the whole box is kept', () => {
    // The classic bounds-clip bug: clipping these away removes precisely the coarse
    // fallback tiles the ladder draws while the leaves stream in.
    expect(kept([t(0, 0, 0), t(1, 0, 0), t(1, 1, 0)])).toEqual(['0/0/0', '1/0/0', '1/1/0'])
  })

  it('EDGE — a tile whose border merely touches the box counts as overlapping', () => {
    // 2/2/1 starts exactly at lon 0; a box ending exactly at lon 0 still touches it.
    expect(kept([t(2, 2, 1)], [-10, 35, 0, 45])).toEqual(['2/2/1'])
  })

  it('NO BOUNDS — an undefined box returns the list unchanged, same array identity', () => {
    const tiles = [t(2, 0, 0), t(2, 1, 1)]
    expect(clipTilesToBounds(tiles, undefined)).toBe(tiles)
  })

  it('garbage bounds normalise to undefined rather than clipping everything away', () => {
    // A hand-built LoadCommand (or a stale host call) must not be able to blank the
    // source: an unusable box means NO clip, which is the pre-existing behaviour.
    for (const bad of [
      undefined,
      null,
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      ['a', 'b', 'c', 'd'],
      [0, 0, Number.NaN, 0],
      [5, 35, -10, 45], // west > east — no wraparound, see the converter's warning
      [-10, 45, 5, 35], // south > north
      [-10, 35, 5, 95], // latitude out of range
    ]) {
      expect(normalizeSourceBounds(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(normalizeSourceBounds(MED)).toEqual(MED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hop 4 — the REAL RasterRenderer.render() stops requesting the outside tiles
// ─────────────────────────────────────────────────────────────────────────────
//
// Oracle: drive the real render() against the WebGPU stub (no GPU — the same harness
// raster-world-copy.test.ts uses) and capture the tile keys it actually asks for. The
// private `loadTileTexture` is replaced by a recorder that frees the in-flight slot
// synchronously, so MAX_CONCURRENT_LOADS cannot truncate the list under assertion.
//
// The un-clipped arm is the DECOY that makes the clipped arm informative: if the
// renderer→clip wire were severed, both arms would return the SAME set and the
// "no outside tile" assertion below would fail naming exactly that.

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => stub.uninstall())

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 2000, height: 800 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const W = 2000
const H = 800
const DPR = 1
const ZOOM = 1 // → rasterCoverZoom(1, 256) = 2, the z2 grid the semantics table uses
const PROJ_TYPE = 0

function requestedKeys(ctx: GPUContext, bounds?: [number, number, number, number]): Set<string> {
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')
  renderer.setSourceBounds(bounds)

  const seen = new Set<string>()
  const priv = renderer as unknown as {
    loadTileTexture: (url: string, signal: AbortSignal) => Promise<unknown>
    loadingTiles: Map<string, unknown>
  }
  priv.loadTileTexture = (url: string) => {
    const m = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
    if (m) seen.add(`${m[1]}/${m[2]}/${m[3]}`)
    priv.loadingTiles.clear() // free the budget so nothing is truncated
    return new Promise<unknown>(() => {})
  }

  const camera = new Camera(0, 0, ZOOM)
  camera.projType = PROJ_TYPE
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(wrapWebGpuPass(encoder.beginRenderPass()), camera, PROJ_TYPE, 0, 0, W, H, 0, DPR)
  return seen
}

describe('#1984 hop 4 — RasterRenderer.render() requests only what the box overlaps', () => {
  it('un-clipped, the whole z2 world is requested (the decoy that makes hop 4 informative)', async () => {
    const keys = requestedKeys(await makeCtx())
    // Guard the oracle: a scenario that never selects an out-of-box tile would let the
    // clipped assertion below pass with the wire cut.
    expect(keys.has('2/0/0')).toBe(true)
    expect(keys.has('2/1/1')).toBe(true)
  })

  it('with bounds, every requested tile overlaps the box — and the box IS covered', async () => {
    const keys = requestedKeys(await makeCtx(), MED)
    expect([...keys].sort()).not.toEqual([])
    // Nothing outside.
    expect(keys.has('2/0/0')).toBe(false)
    expect(keys.has('2/3/3')).toBe(false)
    expect(keys.has('2/1/2')).toBe(false)
    // The two overlapping leaves, and the coarse parents the fallback ladder needs.
    expect(keys.has('2/1/1')).toBe(true)
    expect(keys.has('2/2/1')).toBe(true)
    expect(keys.has('0/0/0')).toBe(true)
  })

  it('the clipped request set is a strict SUBSET of the un-clipped one', async () => {
    const all = requestedKeys(await makeCtx())
    const clipped = requestedKeys(await makeCtx(), MED)
    for (const k of clipped) expect(all.has(k), `${k} appeared only under the clip`).toBe(true)
    expect(clipped.size).toBeLessThan(all.size)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hop 5 — the DEM twin's render() stops requesting too
// ─────────────────────────────────────────────────────────────────────────────
//
// Hop 2 proves the box SURVIVES the params merge and hop 3 proves the predicate is
// right, but neither reaches the one line in HillshadeRenderer.render() that spends
// them (`tiles = clipTilesToBounds(tiles, this._params.bounds)`). Without this block,
// DELETING that line leaves every assertion above green — the DEM half of the feature
// would be wired only in the type system. The raster twin has hop 4; this is its
// mirror, and the two together are what stops the copied-renderer pair from drifting.
//
// A 256-px terrarium DEM at the SAME camera zoom as hop 4 puts both twins on one z2
// grid (rasterCoverZoom(1, 256) = 2), so the semantics table's coordinates read the
// same for both — and the decoy below is what proves the grid is actually reached: at
// hillshade's 512-px default the frustum would have to sit at zoom 2, where 2/0/0 is
// simply off-screen and "not requested" would prove nothing about the clip.

function demRequestedKeys(ctx: GPUContext, bounds?: [number, number, number, number]): Set<string> {
  const renderer = new HillshadeRenderer(ctx)
  armHillshadeSource(renderer, {
    _tileUrl: 'https://dem.example.com/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    bounds,
  })
  renderer.setParams({ tileSize: 256 })

  const seen = new Set<string>()
  const priv = renderer as unknown as {
    loadTileTexture: (url: string, signal: AbortSignal) => Promise<unknown>
    loadingTiles: Map<string, unknown>
  }
  priv.loadTileTexture = (url: string) => {
    const m = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
    if (m) seen.add(`${m[1]}/${m[2]}/${m[3]}`)
    priv.loadingTiles.clear() // free the budget so nothing is truncated
    return new Promise<unknown>(() => {})
  }

  const camera = new Camera(0, 0, ZOOM)
  camera.projType = PROJ_TYPE
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  renderer.render(wrapWebGpuPass(encoder.beginRenderPass()), camera, PROJ_TYPE, 0, 0, W, H, 0, DPR)
  return seen
}

describe('#1984 hop 5 — HillshadeRenderer.render() requests only what the box overlaps', () => {
  it('un-clipped, the DEM selector asks for the out-of-box tiles too (the decoy)', async () => {
    const keys = demRequestedKeys(await makeCtx())
    expect(keys.has('2/0/0')).toBe(true)
    expect(keys.has('2/1/1')).toBe(true)
  })

  it('with bounds, no out-of-box DEM tile is requested and the overlapping ones are', async () => {
    const keys = demRequestedKeys(await makeCtx(), MED)
    expect(keys.has('2/0/0')).toBe(false)
    expect(keys.has('2/3/3')).toBe(false)
    expect(keys.has('2/1/2')).toBe(false)
    expect(keys.has('2/1/1')).toBe(true)
    expect(keys.has('2/2/1')).toBe(true)
    // The coarse parent the DEM fallback ladder shades while the leaves stream in.
    expect(keys.has('0/0/0')).toBe(true)
  })
})

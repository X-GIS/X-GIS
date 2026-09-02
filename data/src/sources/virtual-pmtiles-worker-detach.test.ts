// ═══ A detached backend's late compile must not write into the live catalog (#2359) ═══
//
// `_reseedInPlace` (source-manager.ts, #1371) swaps a virtual source's backend WITHOUT
// destroying the catalog: the old backend is detached and a new one attached to the same
// live catalog. A compile already in the worker pool at that moment resolves afterwards,
// and `fetchAndCompile`'s worker arm wrote its result through the sink CAPTURED at
// `loadTile` time — so the superseded backend's geometry (or, for an empty compile, a
// placeholder that makes `hasTileData` true and blocks the re-fetch) landed on the key the
// NEW backend owns. `compileInline` has had the guard all along (`if (!this.sink) return`);
// the worker arm did not, and nothing exercised it — the neighbouring teardown spec covers
// only the `getTile` REJECTION arm.
//
// The teardown spec's module mock rejects every `getTile`, and `vi.mock` is file-scoped and
// hoisted, so the resolving-getTile scenario needs its own file.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog } from '../tile-catalog'
import { VirtualPMTilesBackend } from './virtual-pmtiles-backend'

const hoisted = vi.hoisted(() => ({
  /** Resolves the in-flight `pool.compile()` — held open so the test controls the
   *  interleaving of detach and resolve. */
  resolveCompile: null as null | ((slices: unknown[]) => void),
  compileStarted: null as null | (() => void),
}))

vi.mock('../workers/geojson-tiling-pool', () => ({
  newTilingInstanceId: () => 'test-instance',
  setSource: () => Promise.resolve(),
  dropSource: () => {},
  // Non-empty bytes, so the flow reaches the compile arm rather than the empty-tile
  // short-circuit above it.
  getTile: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
  isSourceGone: () => false,
}))

vi.mock('../workers/mvt-worker-pool', () => ({
  getSharedMvtPool: () => ({
    compile: () =>
      new Promise((resolve) => {
        hoisted.resolveCompile = resolve as (slices: unknown[]) => void
        hoisted.compileStarted?.()
      }),
  }),
}))

/** One minimal slice — enough for `sliceToBackendResult` and the catalog's cache. */
function oneSlice(): unknown {
  return {
    layerName: 'world',
    vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
    dequantScale: 1,
    dequantHalf: 0,
    indices: new Uint32Array([0, 1, 2]),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    fullCover: false,
    fullCoverFeatureId: 0,
  }
}

const KEY = tileKey(4, 8, 5)
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

/** Attach a backend to a real catalog, request one tile, and return once the compile is
 *  genuinely in flight (not merely queued). */
async function inFlight(): Promise<{ catalog: TileCatalog; backend: VirtualPMTilesBackend }> {
  const catalog = new TileCatalog()
  const backend = new VirtualPMTilesBackend({
    sourceName: 'world',
    geojson: EMPTY_FC,
    layers: [],
  })
  catalog.attachBackend(backend)
  const started = new Promise<void>((r) => (hoisted.compileStarted = r))
  backend.loadTile(KEY)
  await started
  return { catalog, backend }
}

beforeEach(() => {
  hoisted.resolveCompile = null
  hoisted.compileStarted = null
})

// `globalThis.Worker` decides which arm `fetchAndCompile` takes; vitest has none, so the
// inline fallback (which already guards) would run and the worker arm would stay untested.
beforeEach(() => {
  vi.stubGlobal('Worker', class {})
  return () => vi.unstubAllGlobals()
})

describe('VirtualPMTilesBackend — the worker arm re-checks the sink at WRITE time (#2359)', () => {
  it('a compile that resolves after detach writes nothing into the catalog', async () => {
    const { catalog, backend } = await inFlight()
    catalog.detachBackend(backend)
    hoisted.resolveCompile!([oneSlice()])
    await vi.waitFor(() => expect(catalog.isLoading(KEY)).toBe(false))
    expect(catalog.getTileData(KEY, 'world')).toBeNull()
  })

  it('an EMPTY compile after detach does not seed a blocking placeholder either', async () => {
    // The empty branch writes `acceptResult(key, null)`, which makes `hasTileData` true —
    // so the new backend's own load would short-circuit on "already have".
    const { catalog, backend } = await inFlight()
    catalog.detachBackend(backend)
    hoisted.resolveCompile!([])
    await vi.waitFor(() => expect(catalog.isLoading(KEY)).toBe(false))
    expect(catalog.hasTileData(KEY)).toBe(false)
  })

  it('CONTROL — an ATTACHED backend still writes its result through', async () => {
    // Separates "the guard works" from "the worker arm stopped writing at all".
    const { catalog } = await inFlight()
    hoisted.resolveCompile!([oneSlice()])
    await vi.waitFor(() => expect(catalog.isLoading(KEY)).toBe(false))
    expect(catalog.getTileData(KEY, 'world')).not.toBeNull()
  })

  it('loadingTiles is released either way — a detached backend must not wedge the key', async () => {
    // The guard sits inside the `try`, so the existing `finally` still releases. Asserted
    // because a guard placed one level out would leave the key loading forever.
    const { catalog, backend } = await inFlight()
    expect(catalog.isLoading(KEY)).toBe(true)
    catalog.detachBackend(backend)
    hoisted.resolveCompile!([oneSlice()])
    await vi.waitFor(() => expect(catalog.isLoading(KEY)).toBe(false))
  })
})

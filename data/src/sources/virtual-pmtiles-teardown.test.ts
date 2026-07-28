// ═══ Tearing a tile source down is not a fault ═══════════════════════════════
//
// A GeoJSON source's tile requests outlive the source. `SourceManager` evicts the tiling
// worker's index from the catalog's `onDestroy`, so every request still in the air answers
// "unknown source: <name>" — and `VirtualPMTilesBackend` reported each one through
// `xlog.error`. Every style swap in the playground therefore printed one console error per
// in-flight tile, which is what `_graphics-compiled-arrow-parity.spec.ts` (`expect(errors)
// .toEqual([])`) has been failing on.
//
// The fix is TWO-sided and both halves are asserted here, because either one alone is inert:
//
//   1. `TileCatalog.destroy()` detaches its backends BEFORE draining `onDestroy`. Without
//      this the backend never learns it was torn down — it holds a live `sink` forever — so
//      a "am I detached?" guard in the backend gates on a condition that never holds. That
//      is the vacuous half, and it is why the ORDER is asserted, not just the fact.
//   2. The backend treats a `getTile` rejection AFTER detach as teardown, not as an error.
//
// The control in each direction is the point: an ATTACHED backend's rejection is a real
// failure and must still be logged.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { setLogSink } from '@xgis/shared'
import { tileKey } from '@xgis/compiler'
import type { TileSource, TileSourceSink } from '../tile-source'
// Imported statically even though `../workers/geojson-tiling-pool` is mocked below:
// `vi.mock` is hoisted above every import in the file, so these see the mock.
import { TileCatalog } from '../tile-catalog'
import { VirtualPMTilesBackend } from './virtual-pmtiles-backend'

const hoisted = vi.hoisted(() => ({
  rejectTile: null as null | ((e: Error) => void),
}))

vi.mock('../workers/geojson-tiling-pool', () => ({
  newTilingInstanceId: () => 'test-instance',
  setSource: () => Promise.resolve(),
  dropSource: () => {},
  getTile: () =>
    new Promise<Uint8Array>((_resolve, reject) => {
      hoisted.rejectTile = reject
    }),
}))

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

/** Captures engine-log errors instead of letting them reach the console. */
let errors: string[] = []
beforeEach(() => {
  errors = []
  hoisted.rejectTile = null
  setLogSink((level, message, ...args) => {
    if (level === 'error') errors.push([message, ...args.map(String)].join(' '))
  })
})
afterEach(() => setLogSink(null))

/** Minimal sink — the backend only needs the four calls on the rejection path. */
function stubSink(): TileSourceSink {
  return {
    trackLoading: () => {},
    releaseLoading: () => {},
    hasTileData: () => false,
    getLoadingCount: () => 0,
    acceptResult: () => {},
  }
}

describe('TileCatalog.destroy — backends are detached, and detached FIRST', () => {
  /** A backend that records when it was detached, relative to the owner callbacks. */
  function recordingBackend(log: string[]): TileSource {
    return {
      meta: {
        bounds: [-180, -85, 180, 85],
        minZoom: 0,
        maxZoom: 14,
        scheme: 'web-mercator-xyz',
      },
      has: () => true,
      attach: () => {},
      loadTile: () => {},
      detach: () => log.push('detach'),
    }
  }

  it('detaches every attached backend', () => {
    const log: string[] = []
    const catalog = new TileCatalog()
    catalog.attachBackend(recordingBackend(log))
    catalog.attachBackend(recordingBackend(log))
    catalog.destroy()
    expect(log).toEqual(['detach', 'detach'])
  })

  it('detaches BEFORE the onDestroy callbacks that pull the data out', () => {
    // The ordering IS the contract. `onDestroy` is where SourceManager drops the tiling
    // worker index; a backend told afterwards cannot distinguish teardown from breakage.
    const log: string[] = []
    const catalog = new TileCatalog()
    catalog.attachBackend(recordingBackend(log))
    catalog.onDestroy(() => log.push('dropSource'))
    catalog.destroy()
    expect(log).toEqual(['detach', 'dropSource'])
  })

  it('is idempotent — a second destroy detaches nothing and re-runs nothing', () => {
    const log: string[] = []
    const catalog = new TileCatalog()
    catalog.attachBackend(recordingBackend(log))
    catalog.onDestroy(() => log.push('dropSource'))
    catalog.destroy()
    catalog.destroy()
    expect(log).toEqual(['detach', 'dropSource'])
  })
})

describe('VirtualPMTilesBackend — a rejection after detach is teardown, not an error', () => {
  const KEY = tileKey(4, 8, 5)

  /** Build a backend, ask for one tile, and hand back the in-flight rejector. */
  async function inFlight(): Promise<VirtualPMTilesBackend> {
    const backend = new VirtualPMTilesBackend({
      sourceName: 'world',
      geojson: EMPTY_FC,
      layers: [],
    })
    backend.attach(stubSink())
    backend.loadTile(KEY)
    // Let `indexReady.then(...)` run so fetchAndCompile is actually awaiting getTile.
    await vi.waitFor(() => expect(hoisted.rejectTile).not.toBeNull())
    return backend
  }

  it('stays silent when the source was torn down mid-flight', async () => {
    const backend = await inFlight()
    backend.detach()
    hoisted.rejectTile!(new Error('unknown source: world'))
    await vi.waitFor(() => expect(errors).toEqual([]))
    // Give the rejection a further turn to surface — waitFor on an empty array passes on the
    // first tick, so without this the assertion could pass before the catch even ran.
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual([])
  })

  it('CONTROL — an attached backend still reports a real getTile failure', async () => {
    await inFlight()
    hoisted.rejectTile!(new Error('worker exploded'))
    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toContain('[virtual-pmtiles getTile]')
    expect(errors[0]).toContain('worker exploded')
  })
})

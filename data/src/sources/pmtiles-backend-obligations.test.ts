// ═══ #1571 — PMTilesBackend honours the three TileSource obligations ═══
//
// `PMTilesBackend` sits behind every remote PMTiles / TileJSON source and ignored
// three things the `TileSource` interface defines and its own virtual sibling
// implements. Each case below carries the CONTROL arm that proves it is testing the
// obligation rather than a backend that does nothing:
//
//   detach()     — was absent, so `TileCatalog.destroy()`'s `backend.detach?.()` was a
//                  silent no-op for the one backend carrying every remote source.
//   force        — was dropped from the signature while the `hasTileData` guard it
//                  exists to bypass was present, which `tile-source.ts` states is the
//                  one combination a backend may not have.
//   failedKeys   — was uncapped, unswept, and deliberately REWRITTEN on TTL expiry to
//                  preserve backoff state, so entries lived for the map's lifetime over
//                  an unbounded (packed tile key) key space.
//
// Structure mirrors virtual-pmtiles-teardown.test.ts, whose two-sided discipline is the
// template: assert the teardown, and assert the still-attached control case.

import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { PMTilesBackend, type PMTilesFetcher } from './pmtiles-backend'
import type { TileSourceSink, BackendTileResult } from '../tile-source'

function makeSink(has: (key: number) => boolean = () => false) {
  const events: { key: number; result: BackendTileResult | null }[] = []
  let loadingCount = 0
  const sink: TileSourceSink = {
    trackLoading: () => {
      loadingCount++
    },
    releaseLoading: () => {
      loadingCount--
    },
    hasTileData: has,
    getLoadingCount: () => loadingCount,
    acceptResult: (key, result) => {
      events.push({ key, result })
    },
  }
  return { sink, events }
}

function makeBackend(fetcher: PMTilesFetcher): PMTilesBackend {
  return new PMTilesBackend({ fetcher, minZoom: 0, maxZoom: 18, bounds: [-180, -85, 180, 85] })
}

describe('#1571 detach() drains the queue and stops dispatching', () => {
  it('a post-detach queue dispatches nothing more', async () => {
    // A gated fetcher: every call parks until `release()`, so the queue is provably
    // still holding work at the moment detach() runs.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const fetcher: PMTilesFetcher = async () => {
      calls++
      await gate
      return null
    }
    const backend = makeBackend(fetcher)
    const { sink } = makeSink()
    backend.attach(sink)

    // Well past maxJobs, so most keys are QUEUED rather than in flight.
    for (let i = 0; i < 30; i++) backend.loadTile(tileKey(10, 100 + i, 200))
    const dispatchedBeforeDetach = calls
    expect(dispatchedBeforeDetach, 'the queue caps concurrency, so not all 30 ran').toBeLessThan(30)

    backend.detach()
    release()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // Before the fix the PriorityQueue (autoUpdate; both `add` and completion
    // re-schedule) drained EVERY queued job — the code's own comment puts depth at
    // 200+ — and `doFetch`'s only gate, `if (!this.sink) return`, passed forever
    // because nothing ever cleared the sink.
    expect(calls, 'no queued job may dispatch after detach()').toBe(dispatchedBeforeDetach)
  })

  it('detach() clears the sink and drops the pending bytes', () => {
    const backend = makeBackend(async () => null)
    const { sink } = makeSink()
    backend.attach(sink)
    const inner = backend as unknown as {
      sink: unknown
      pendingMvt: unknown[]
      abortControllers: Map<number, AbortController>
    }
    const ctrl = new AbortController()
    inner.abortControllers.set(tileKey(3, 1, 1), ctrl)
    inner.pendingMvt.push({ key: tileKey(3, 1, 1), bytes: new Uint8Array(4) })

    backend.detach()

    expect(ctrl.signal.aborted, 'in-flight fetches are aborted').toBe(true)
    expect(inner.abortControllers.size).toBe(0)
    // `pendingMvt` is drained only by `tick()` from `TileCatalog.resetCompileBudget`,
    // which is never called again after destroy — so bytes left here accumulate on a
    // dead backend until every queued job settles.
    expect(inner.pendingMvt.length, 'bytes that will never compile are dropped').toBe(0)
    expect(inner.sink, 'and the sink is released, closing doFetch-s gate').toBeNull()
  })

  it('CONTROL — an attached backend still dispatches', async () => {
    let calls = 0
    const backend = makeBackend(async () => {
      calls++
      return null
    })
    const { sink } = makeSink()
    backend.attach(sink)
    backend.loadTile(tileKey(10, 100, 200))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls, 'without this the detach cases above would pass vacuously').toBe(1)
  })
})

describe('#1571 loadTile honours `force`', () => {
  it('re-fetches a key the sink already has when force is set', async () => {
    let calls = 0
    const backend = makeBackend(async () => {
      calls++
      return null
    })
    // The sink reports it ALREADY has this key — the exact state `force` exists for:
    // a re-seed swapped the backend, so the held data is the PREVIOUS backend's output.
    const { sink } = makeSink(() => true)
    backend.attach(sink)
    const k = tileKey(10, 100, 200)

    backend.loadTile(k)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls, 'without force the already-have guard short-circuits — unchanged').toBe(0)

    backend.loadTile(k, true)
    await new Promise((r) => setTimeout(r, 0))
    // Before the fix this stayed 0: the signature took `key` only (TS accepts the
    // narrower method), so `refreshTiles` silently did nothing while the catalog's
    // `_pendingRefresh` bookkeeping claimed a refresh was in flight.
    expect(calls, 'force must bypass the guard, as the virtual sibling does').toBe(1)
  })
})

describe('#1571 failedKeys is bounded', () => {
  it('caps at 4096 over an unbounded key space', async () => {
    // Panning a broken upstream at z10-17 visits 10^4-10^5 distinct keys; every one
    // used to be retained for the backend's whole life, because the only delete is a
    // later SUCCESSFUL re-fetch and TTL expiry REWRITES rather than drops.
    const backend = makeBackend(async () => 'failed')
    const { sink } = makeSink()
    backend.attach(sink)
    const inner = backend as unknown as { __failedKeysSizeForTest(): number }

    for (let i = 0; i < 5000; i++) backend.loadTile(tileKey(14, 1000 + i, 2000))
    // Drain the gated queue.
    for (let i = 0; i < 200; i++) await new Promise((r) => setTimeout(r, 0))

    const size = inner.__failedKeysSizeForTest()
    expect(size, 'some failures were actually recorded').toBeGreaterThan(0)
    expect(
      size,
      'and the ledger is capped, like vector-tile-loader-s negative cache',
    ).toBeLessThanOrEqual(4096)
  })

  it('a fully-expired entry past the grace window is dropped, not rewritten forever', () => {
    const backend = makeBackend(async () => 'failed')
    const { sink } = makeSink()
    backend.attach(sink)
    const inner = backend as unknown as {
      failedKeys: Map<number, { expiresAt: number; count: number }>
      noteFailedKey(key: number, expiresAt: number, count: number): void
      __failedKeysSizeForTest(): number
    }
    const stale = tileKey(14, 1, 1)
    // An entry whose TTL lapsed well beyond the grace window — the tile has been
    // healthy (or unvisited) long enough that its old failure count is no longer
    // evidence about it, so keeping it buys nothing and costs a slot.
    inner.failedKeys.set(stale, { expiresAt: Date.now() - 60 * 60_000, count: 3 })
    expect(inner.__failedKeysSizeForTest()).toBe(1)

    inner.noteFailedKey(tileKey(14, 2, 2), Date.now() + 15_000, 1)

    expect(inner.failedKeys.has(stale), 'the stale entry is swept on the next write').toBe(false)
    expect(inner.failedKeys.has(tileKey(14, 2, 2)), 'the fresh one stays').toBe(true)
  })

  it('CONTROL — a still-valid entry is kept, so the backoff still works', () => {
    const backend = makeBackend(async () => 'failed')
    backend.attach(makeSink().sink)
    const inner = backend as unknown as {
      failedKeys: Map<number, { expiresAt: number; count: number }>
      noteFailedKey(key: number, expiresAt: number, count: number): void
    }
    const live = tileKey(14, 5, 5)
    inner.failedKeys.set(live, { expiresAt: Date.now() + 15_000, count: 2 })
    inner.noteFailedKey(tileKey(14, 6, 6), Date.now() + 15_000, 1)
    expect(inner.failedKeys.get(live)?.count, 'an unexpired entry keeps its backoff').toBe(2)
  })
})

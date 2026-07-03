// Isolation + lifecycle contract for the GeoJSON tiling pool.
//
// BUG 8 (cross-map index collision): the tiling worker is a process-global
// singleton shared by every XGISMap on the page, and it used to key its
// retained GeoJSONVT indexes PURELY by the user-chosen source name. Two maps
// each declaring a GeoJSON source with the same name (the common default
// 'geojson') therefore clobbered each other's index — map B's setSource
// overwrote map A's index under the same key, and map A's getTile then sliced
// map B's geometry (silent cross-map corruption). The fix namespaces the
// worker index key with a per-caller `instanceId` (one per map/SourceManager)
// composed as `${instanceId}::${sourceName}`, keeping the user-facing
// sourceName separate. This test pins that two distinct instanceIds with the
// SAME source name produce DISTINCT composed keys in the posted payloads.
//
// BUG 7 (index leak on detach/replace): the per-source GeoJSONVT index was
// never evicted on source detach/replace, so it leaked for the process
// lifetime. The fix adds a fire-and-forget `dropSource` that posts a
// 'drop-source' message carrying the composed key. This test pins that
// dropSource posts that message for the right key.
//
// The tiling pool spawns its worker via `new Worker(new URL(...))` (NOT a
// `?worker` default import), so we stub the global Worker constructor with a
// FakeWorker that records postMessage payloads and lets the test settle the
// setSource promise by emitting a synthetic 'message' event.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

type Listener = (e: unknown) => void

/** Records constructor args + every postMessage payload; replays a synthetic
 *  'message' so the pool's pending promise can resolve. */
class FakeWorker {
  static instances: FakeWorker[] = []
  listeners: Record<string, Listener[]> = {}
  posted: any[] = []
  terminated = false

  constructor(_url?: unknown, _opts?: unknown) {
    FakeWorker.instances.push(this)
  }
  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
}

// Import the pool FRESH per test so its module-level singleton (`_worker`,
// task counter, instance-id counter) starts clean.
async function freshPool(): Promise<typeof import('./geojson-tiling-pool')> {
  vi.resetModules()
  return import('./geojson-tiling-pool')
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const FC = { type: 'FeatureCollection', features: [] }

describe('geojson-tiling-pool isolation (BUG 8 — per-caller namespaced index key)', () => {
  it('two callers with the SAME source name post DISTINCT composed index keys', async () => {
    const pool = await freshPool()

    // Two distinct maps' SourceManagers each mint their own instance id.
    const idA = pool.newTilingInstanceId()
    const idB = pool.newTilingInstanceId()
    expect(idA).not.toBe(idB)

    // Both declare a source with the SAME user-facing name.
    void pool.setSource(idA, 'geojson', FC)
    void pool.setSource(idB, 'geojson', FC)

    // One shared singleton worker received both set-source messages.
    expect(FakeWorker.instances.length).toBe(1)
    const setMsgs = FakeWorker.instances[0].posted.filter((m) => m.kind === 'set-source')
    expect(setMsgs.length).toBe(2)

    // The user-facing sourceName is identical on both...
    expect(setMsgs[0].sourceName).toBe('geojson')
    expect(setMsgs[1].sourceName).toBe('geojson')

    // ...but the worker-side index key (what `indexes` is keyed by) is
    // DISTINCT — no collision, so map A's getTile can never slice map B's
    // geometry. (Pre-fix the worker keyed by sourceName → identical → clobber.)
    expect(setMsgs[0].indexKey).not.toBe(setMsgs[1].indexKey)
    expect(setMsgs[0].indexKey).toBe(`${idA}::geojson`)
    expect(setMsgs[1].indexKey).toBe(`${idB}::geojson`)
  })

  it('getTile carries the same composed key as its setSource (routes to the caller-owned index)', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()

    void pool.setSource(id, 'geojson', FC)
    void pool.getTile(id, 'geojson', 3, 1, 2, 999)

    const posted = FakeWorker.instances[0].posted
    const set = posted.find((m) => m.kind === 'set-source')
    const get = posted.find((m) => m.kind === 'get-tile')
    expect(get.indexKey).toBe(set.indexKey)
    // sourceName is preserved separately for the encoded MVT layer name.
    expect(get.sourceName).toBe('geojson')
  })
})

describe('geojson-tiling-pool eviction (BUG 7 — dropSource frees the retained index)', () => {
  it('dropSource posts a drop-source message for the composed key', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()

    // setSource spins up the worker and indexes under `${id}::geojson`.
    void pool.setSource(id, 'geojson', FC)
    const indexKey = FakeWorker.instances[0].posted.find((m) => m.kind === 'set-source').indexKey

    // Detach/replace path drops the source.
    pool.dropSource(id, 'geojson')

    const drop = FakeWorker.instances[0].posted.find((m) => m.kind === 'drop-source')
    expect(drop, 'dropSource must post a drop-source message').toBeDefined()
    expect(drop.indexKey).toBe(indexKey)
  })

  it('dropSource only targets the calling map — a sibling map index key is never dropped', async () => {
    const pool = await freshPool()
    const idA = pool.newTilingInstanceId()
    const idB = pool.newTilingInstanceId()

    void pool.setSource(idA, 'geojson', FC)
    void pool.setSource(idB, 'geojson', FC)

    // Map A detaches its source.
    pool.dropSource(idA, 'geojson')

    const drops = FakeWorker.instances[0].posted.filter((m) => m.kind === 'drop-source')
    expect(drops.length).toBe(1)
    expect(drops[0].indexKey).toBe(`${idA}::geojson`)
    // Map B's index key is untouched.
    expect(drops[0].indexKey).not.toBe(`${idB}::geojson`)
  })

  it('dropSource with no worker ever spawned is a no-op (never throws / never spawns)', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()
    expect(() => pool.dropSource(id, 'geojson')).not.toThrow()
    expect(FakeWorker.instances.length).toBe(0)
  })
})

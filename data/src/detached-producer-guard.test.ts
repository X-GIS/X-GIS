// ═══ #2391 — a released producer must not still be able to write ═══
//
// Two defects of one shape, from the ownership audit's P2 list: work is handed to
// a producer, the producer's owner is released, and the producer's result still
// reaches state that outlives it.
//
//   F-8  TileCatalog.acceptResult never asked whether `backend` was still
//        attached. `detachBackend` reaches the producer only through
//        `backend.detach?.()` — an optional chain that was a silent no-op for
//        every remote PMTiles/TileJSON source until #1571, and still is for any
//        backend that omits it. So the catalog cannot rely on a producer stopping
//        when asked; the check has to be catalog-side.
//
//   F-6  MvtWorkerPool.compile recorded its `pending` entry and then called
//        postMessage bare. A synchronous throw there rejects the promise — every
//        caller path is already correct — but leaves the entry in the map forever.
//
// THE ARM THAT CARRIES THE INFORMATION is `attach()-time emit still lands`. The
// obvious spelling of the F-8 guard is `!this.backends.includes(backend) -> return`,
// and it is WRONG: attachBackend used to hand over the sink BEFORE recording
// membership, while geojson-polar-cap-backend and synthetic-earth-surface-backend
// both push a result synchronously from inside attach(). That guard drops the polar
// caps and the synthetic earth surface outright — a silent, global regression. The
// fix is the ordering; this arm is what holds it in place.

import { describe, it, expect } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog, MvtWorkerPool } from '@xgis/data'
import {
  TILE_LAYOUT_VERSION,
  type TileSource,
  type TileSourceSink,
  type BackendTileResult,
} from '@xgis/data'

const RESULT: BackendTileResult = {
  vertices: new Float32Array(0),
  dequantScale: 0,
  dequantHalf: 0,
  indices: new Uint32Array(0),
  lineVertices: new Float32Array(0),
  lineIndices: new Uint32Array(0),
}

const META = {
  bounds: [-180, -85, 180, 85] as [number, number, number, number],
  minZoom: 0,
  maxZoom: 4,
  scheme: 'web-mercator-xyz' as const,
  layoutVersion: TILE_LAYOUT_VERSION,
}

/** A backend that hands its sink back to the test, so a result can be pushed at
 *  any point in the lifecycle — including after the catalog has detached it,
 *  which is exactly what an in-flight load does. */
function lateBackend(): TileSource & { push(key: number, layer?: string): void } {
  let sink: TileSourceSink | null = null
  return {
    get meta() {
      return META
    },
    has: () => true,
    attach(s) {
      sink = s
    },
    loadTile(key) {
      sink?.trackLoading(key)
    },
    push(key, layer) {
      sink!.acceptResult(key, RESULT, layer)
    },
  }
}

/** The polar-cap / synthetic-surface shape: emits from INSIDE attach(), before
 *  attachBackend has returned. */
function eagerBackend(key: number): TileSource {
  return {
    get meta() {
      return META
    },
    has: () => true,
    attach(sink) {
      sink.acceptResult(key, RESULT, '')
    },
    loadTile() {},
  }
}

describe('#2391 F-8 — a detached backend cannot still write to the catalog', () => {
  it('DROPS a result pushed after detachBackend', () => {
    const catalog = new TileCatalog()
    const backend = lateBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 1, 1)
    catalog.detachBackend(backend)
    backend.push(key) // the in-flight load resolving after the reseed

    expect(
      catalog.getTileData(key),
      'a released producer must not land geometry the catalog would then own',
    ).toBeNull()
  })

  it('CONTROL — the same push while still attached lands', () => {
    // Without this the guard could reject everything and the arm above would
    // pass on a catalog that stores nothing at all.
    const catalog = new TileCatalog()
    const backend = lateBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 1, 1)
    backend.push(key)

    expect(catalog.getTileData(key), 'an attached producer still writes').not.toBeNull()
    expect(catalog.getTileData(key)!.originBackend).toBe(backend)
  })

  it('a backend that emits SYNCHRONOUSLY from attach() still lands', () => {
    // THE arm that decides the guard. `attachBackend` records membership before
    // handing over the sink precisely so this works; reverse those two statements
    // and the polar caps and the synthetic earth surface vanish with no error.
    const catalog = new TileCatalog()
    const key = tileKey(0, 0, 0)
    catalog.attachBackend(eagerBackend(key))

    expect(
      catalog.getTileData(key),
      'the polar-cap / synthetic-surface shape emits from inside attach()',
    ).not.toBeNull()
  })

  it('re-attaching a detached backend restores its write access', () => {
    // `this.backends` is the single authority, so this falls out rather than
    // needing its own bookkeeping — the arm pins that there is no second one.
    const catalog = new TileCatalog()
    const backend = lateBackend()
    catalog.attachBackend(backend)
    catalog.detachBackend(backend)
    catalog.attachBackend(backend)

    const key = tileKey(2, 1, 1)
    backend.push(key)

    expect(catalog.getTileData(key), 'a re-attached backend is attached').not.toBeNull()
  })
})

/** A Worker stand-in whose postMessage throws, standing in for a structured-clone
 *  failure of the style-derived payload. */
class ThrowingWorker {
  postMessage(): never {
    throw new DOMException('could not be cloned', 'DataCloneError')
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: unknown = null
  onerror: unknown = null
}

/** Same stand-in, minus the throw — the success-path control. */
class SilentWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: unknown = null
  onerror: unknown = null
}

/** Drive `compile()` against a pool whose workers are the given stand-ins, without
 *  booting a real worker: `ensureWorkers` is a no-op once `workers` is non-empty. */
function pooledWith(worker: object): MvtWorkerPool {
  const pool = new MvtWorkerPool()
  Object.assign(pool, { workers: [worker], ensureWorkers: () => {} })
  return pool
}

describe('#2391 F-6 — a failed postMessage does not orphan its pending entry', () => {
  it('rejects AND releases the entry when postMessage throws', async () => {
    const pool = pooledWith(new ThrowingWorker())
    const before = pool.pendingCount

    await expect(
      pool.compile(new ArrayBuffer(8), 1, 0, 0, 4, 1, 1),
      'the rejection is what frees the catalog loading slot — it must survive the fix',
    ).rejects.toThrow(/cloned/)

    expect(pool.pendingCount, 'and the map entry must not outlive the settled promise').toBe(before)
  })

  it('CONTROL — a successful post DOES leave the entry pending', () => {
    // The job is in flight until 'compile-done' arrives, so the counter must go
    // up here. Without this the fix could delete unconditionally and every real
    // compile would lose its resolver.
    const pool = pooledWith(new SilentWorker())
    void pool.compile(new ArrayBuffer(8), 1, 0, 0, 4, 1, 1)

    expect(pool.pendingCount, 'an in-flight compile is pending').toBe(1)
  })
})

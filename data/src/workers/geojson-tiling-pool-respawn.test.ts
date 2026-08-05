// ═══ #1572 D — a respawned tiling worker is handed back the indexes it is expected
// to know ═══
//
// The tiling worker is a process-global singleton. On a worker `'error'` (script-load
// failure, OOM kill) the pool rejects its pendings and nulls `_worker`; the next `getTile`
// lazily spawns a fresh one. That fresh worker's `indexes` map is EMPTY, and an unknown
// index is answered with `tile-error` + `sourceGone: true` — the flag whose whole meaning
// is "the map was disposed / the source was replaced". `virtual-pmtiles-backend.ts:196`
// reads that as benign teardown: `xlog.debug`, then `acceptResult(key, null)`, which
// caches an empty placeholder, which makes `hasTileData` true, which short-circuits
// `loadTile` forever. So after ONE mid-session crash every newly requested tile of a
// still-live source renders empty for the rest of the session, logged at `debug`.
//
// The fix records each registered `set-source` and replays it into a newly spawned worker
// before any `get-tile` can reach it. Message-queue order does the synchronisation — no
// promise plumbing, and the replay is provably ahead of the request below.
//
// Harness mirrors geojson-tiling-pool-isolation.test.ts (global `Worker` stub, fresh
// module per test), because the two tests exercise the same singleton.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

type Listener = (e: unknown) => void

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

describe('#1572 D — index replay after a worker respawn', () => {
  it('the respawned worker is given the index BEFORE the tile request that spawned it', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()

    pool.setSource(id, 'geojson', FC).catch(() => {})
    const first = FakeWorker.instances[0]
    const indexKey = first.posted.find((m) => m.kind === 'set-source').indexKey
    // Land the index build so this is unambiguously a LIVE, fully-registered source —
    // the state where `sourceGone` is a lie.
    first.emit('message', { data: { kind: 'set-source-done', taskId: 1, sourceName: 'geojson' } })

    // The worker dies mid-session (module chunk 404 on a deploy rollover, OOM kill).
    first.emit('error', { message: 'worker died' })

    // The next tile request spawns a replacement.
    void pool.getTile(id, 'geojson', 3, 1, 2, 999)
    expect(FakeWorker.instances.length, 'a replacement worker was spawned').toBe(2)
    const second = FakeWorker.instances[1]

    // Before the fix `second.posted` was `[get-tile]` alone, against an empty `indexes`
    // map — answered `sourceGone: true` for a source that is very much alive.
    const kinds = second.posted.map((m) => m.kind)
    expect(kinds, 'the index is replayed, and it precedes the get-tile').toEqual([
      'set-source',
      'get-tile',
    ])
    const replay = second.posted[0]
    expect(replay.indexKey, 'replayed under the same composed key').toBe(indexKey)
    expect(replay.geojson, 'with the same data the source was seeded from').toBe(FC)
    // A fresh taskId, so a late reply from the dead worker cannot be mistaken for it.
    expect(replay.taskId).not.toBe(1)
  })

  it('a dropped source is NOT replayed — the record is released with the worker-side index', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()

    // `.catch` rather than `void`: the worker 'error' below rejects every pending
    // setSource by design, and an unhandled rejection would fail the RUN, not the test.
    pool.setSource(id, 'live', FC).catch(() => {})
    pool.setSource(id, 'dropped', FC).catch(() => {})
    const first = FakeWorker.instances[0]
    pool.dropSource(id, 'dropped')

    first.emit('error', { message: 'worker died' })
    void pool.getTile(id, 'live', 3, 1, 2, 999)

    const replays = FakeWorker.instances[1].posted.filter((m) => m.kind === 'set-source')
    expect(replays.length, 'only the live source is rebuilt').toBe(1)
    expect(replays[0].indexKey).toBe(`${id}::live`)
    // Retention, not just correctness: the replay record holds the caller's
    // FeatureCollection, so a source that was dropped must not keep it alive.
    expect(replays.some((m) => m.indexKey === `${id}::dropped`)).toBe(false)
  })

  it('CONTROL — a first spawn replays nothing, so a healthy boot is byte-identical', async () => {
    const pool = await freshPool()
    const id = pool.newTilingInstanceId()

    // getTile with no prior setSource: the pool spawns its first worker here. Without the
    // control, an unconditional replay loop would be indistinguishable from the fix.
    void pool.getTile(id, 'never-seeded', 3, 1, 2, 999)

    const posted = FakeWorker.instances[0].posted
    expect(posted.map((m) => m.kind)).toEqual(['get-tile'])
  })
})

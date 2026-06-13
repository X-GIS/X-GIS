// Worker-side proof of the index-isolation + drop-source contract.
//
// BUG 8: the worker keyed its retained GeoJSONVT indexes by the bare
// `sourceName`. Two callers (two maps) with the same source name collided on
// this process-global singleton. The fix keys `indexes` by the pool-composed
// `indexKey` (`${instanceId}::${sourceName}`). This test drives the worker's
// message handler directly and proves two indexKeys retain INDEPENDENT
// indexes (no clobber), and that get-tile routes by indexKey.
//
// BUG 7: a 'drop-source' message must delete exactly the targeted index so a
// detached/replaced source's index is freed (and a subsequent get-tile is no
// longer served stale — it reports "unknown source").
//
// The worker registers its handler on `self`, which is undefined under the
// vitest node environment — so we stub a minimal `self` BEFORE importing the
// module, and mock the @xgis/compiler index/encode functions so the test
// needs no real geojsonvt pipeline (and no GPU).

import { describe, expect, it, vi, beforeEach } from 'vitest'

type Listener = (e: unknown) => void

// A tiny fake DedicatedWorkerGlobalScope that records the 'message' listener
// the worker registers and the messages it posts back.
const scope = vi.hoisted(() => {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const posted: any[] = []
  return {
    listeners,
    posted,
    addEventListener(type: string, fn: Listener) {
      ;(listeners[type] ??= []).push(fn)
    },
    postMessage(msg: unknown) {
      posted.push(msg)
    },
    /** Deliver a synthetic message to the worker's handler. */
    send(data: unknown) {
      for (const fn of listeners['message'] ?? []) fn({ data })
    },
    reset() {
      posted.length = 0
    },
  }
})

vi.stubGlobal('self', scope as unknown as typeof globalThis)

// Mock the compiler pipeline. `geojsonvt` returns a tagged index whose
// getTile yields a one-feature tile so encodeMVT emits non-empty bytes; the
// tag lets us assert WHICH index served a tile. `encodeMVT` echoes the tag.
vi.mock('@xgis/compiler', () => {
  return {
    // The index's getTile yields a tile that carries the source's tag, so the
    // bytes encodeMVT emits reveal WHICH index served the request.
    geojsonvt: (geojson: any) => ({
      getTile: (_z: number, _x: number, _y: number) => ({ features: [{}], __tag: geojson.__tag }),
    }),
    encodeMVT: (layers: any[]) => {
      const tag = layers[0].tile.__tag as number
      return new Uint8Array([tag])
    },
  }
})

// Import AFTER the stubs so the top-level `self.addEventListener` registers
// against our fake scope.
beforeEach(async () => {
  scope.reset()
  await import('./geojson-tiling-worker')
})

let nextTask = 1

function setSource(indexKey: string, tag: number): void {
  scope.send({
    kind: 'set-source',
    taskId: nextTask++,
    indexKey,
    sourceName: indexKey.split('::')[1],
    geojson: { __tag: tag },
  })
}
function getTile(indexKey: string): any {
  scope.send({
    kind: 'get-tile',
    taskId: nextTask++,
    indexKey,
    sourceName: indexKey.split('::')[1],
    z: 0, x: 0, y: 0, key: 7,
  })
  return scope.posted[scope.posted.length - 1]
}

describe('geojson-tiling-worker index isolation (BUG 8)', () => {
  it('two index keys with the same source name retain INDEPENDENT indexes', () => {
    // Two maps, same user-facing name 'geojson', distinct composed keys.
    setSource('gjt1::geojson', 11)
    setSource('gjt2::geojson', 22)

    // Map A's tile must be sliced from map A's index (tag 11), NOT map B's.
    // Pre-fix both set-source calls keyed `indexes` by 'geojson', so the
    // second clobbered the first and BOTH get-tiles returned tag 22.
    const a = getTile('gjt1::geojson')
    expect(a.kind).toBe('tile')
    expect(Array.from(a.bytes)).toEqual([11])

    const b = getTile('gjt2::geojson')
    expect(b.kind).toBe('tile')
    expect(Array.from(b.bytes)).toEqual([22])
  })
})

describe('geojson-tiling-worker drop-source eviction (BUG 7)', () => {
  it('drop-source deletes exactly the targeted index; later get-tile is not served stale', () => {
    setSource('gjt1::geojson', 11)
    setSource('gjt2::geojson', 22)

    // Drop only map A's index.
    scope.send({ kind: 'drop-source', indexKey: 'gjt1::geojson' })

    // Map A's index is gone → get-tile reports unknown source (NOT stale data).
    const a = getTile('gjt1::geojson')
    expect(a.kind).toBe('tile-error')
    expect(a.message).toContain('unknown source')

    // Map B's sibling index survives the drop.
    const b = getTile('gjt2::geojson')
    expect(b.kind).toBe('tile')
    expect(Array.from(b.bytes)).toEqual([22])
  })
})

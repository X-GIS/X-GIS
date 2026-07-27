import { describe, expect, it } from 'vitest'
import { installS111Mosaic, type MosaicMap } from './s111-mosaic'

type LngLatBounds = [[number, number], [number, number]]

// Viewport envelopes [[W,S],[E,N]] over regions with a known covering model.
const CHESAPEAKE: LngLatBounds = [
  [-77, 37],
  [-76, 38],
]
const SF_BAY: LngLatBounds = [
  [-122.6, 37.5],
  [-122.1, 38.0],
]
const MID_PACIFIC: LngLatBounds = [
  [-160, 10],
  [-150, 20],
]

function makeMap(initial: LngLatBounds) {
  let bounds = initial
  let listener: (() => void) | null = null
  const armed: string[] = [] // model key of each setCoverageData call, in order
  const armedOpts: ({ url?: string; group?: number } | undefined)[] = []
  const map: MosaicMap = {
    getBounds: () => bounds,
    on: (_t, l) => {
      listener = l
    },
    off: (_t, l) => {
      if (listener === l) listener = null
    },
    setCoverageData: async (_id, bytes, opts) => {
      armed.push(new TextDecoder().decode(bytes))
      armedOpts.push(opts)
    },
  }
  return {
    map,
    pan: (b: LngLatBounds) => {
      bounds = b
      listener?.()
    },
    armed,
    armedOpts,
    hasListener: () => listener !== null,
  }
}

function countingFetch() {
  const fetched: string[] = []
  const fetch = (async (url: string) => {
    const key = /latest\/(\w+)\.h5/.exec(url)![1]!
    fetched.push(key)
    return new Response(new TextEncoder().encode(key), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, fetched }
}

// Drain the async IIFE (fetch → arrayBuffer → setCoverageData) each move-end fires.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('installS111Mosaic (#1272 E-④)', () => {
  it('loads the covering model for the initial view, then swaps on a pan', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')
    expect(f.fetched).toEqual(['cbofs'])
    expect(m.armed).toEqual(['cbofs'])

    m.pan(SF_BAY)
    await flush()
    expect(h.current()).toBe('sfbofs')
    expect(f.fetched).toEqual(['cbofs', 'sfbofs'])
    expect(m.armed).toEqual(['cbofs', 'sfbofs'])
  })

  it('serves a pan-back from the LRU — no re-fetch', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    m.pan(SF_BAY)
    await flush()
    m.pan(CHESAPEAKE) // back
    await flush()
    // cbofs was cached → NOT fetched again, but IS re-armed
    expect(f.fetched).toEqual(['cbofs', 'sfbofs'])
    expect(m.armed).toEqual(['cbofs', 'sfbofs', 'cbofs'])
  })

  it('does nothing over open ocean (no covering model)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    m.pan(MID_PACIFIC)
    await flush()
    expect(h.current()).toBe('cbofs') // last covering model stays shown
    expect(f.fetched).toEqual(['cbofs']) // no fetch over open ocean
    expect(m.armed).toEqual(['cbofs'])
  })

  it('evicts the least-recently-used cell past maxCached', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, maxCached: 1 })
    await flush()
    m.pan(SF_BAY) // evicts cbofs (maxCached 1)
    await flush()
    m.pan(CHESAPEAKE) // cbofs evicted → must re-fetch
    await flush()
    expect(f.fetched).toEqual(['cbofs', 'sfbofs', 'cbofs'])
  })

  it('fires onSwap with the model key after each successful swap (overlay re-arm hook)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const swaps: string[] = []
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, onSwap: (k) => swaps.push(k) })
    await flush()
    m.pan(SF_BAY)
    await flush()
    expect(swaps).toEqual(['cbofs', 'sfbofs'])
  })

  it('fires onLoadStart only for a real fetch, never on a cache hit (loading-indicator hook)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const starts: string[] = []
    installS111Mosaic(m.map, {
      sourceId: 'currents',
      fetch: f.fetch,
      onLoadStart: (k) => starts.push(k),
    })
    await flush()
    expect(starts).toEqual(['cbofs']) // initial view — a real fetch

    m.pan(SF_BAY)
    await flush()
    expect(starts).toEqual(['cbofs', 'sfbofs']) // new region — a real fetch

    m.pan(CHESAPEAKE) // back to a cached cell — NO fetch, so no loading start
    await flush()
    expect(starts).toEqual(['cbofs', 'sfbofs'])
  })

  it('fires onLoadError with the model key + error on a failed fetch, never on success', async () => {
    let failNext = true
    const failing = (async (url: string) => {
      const key = /latest\/(\w+)\.h5/.exec(url)![1]!
      if (key === 'sfbofs' && failNext) {
        failNext = false
        return new Response('', { status: 502 })
      }
      return new Response(new TextEncoder().encode(key), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const m = makeMap(CHESAPEAKE)
    const errors: [string, unknown][] = []
    installS111Mosaic(m.map, {
      sourceId: 'currents',
      fetch: failing,
      onLoadError: (k, err) => errors.push([k, err]),
    })
    await flush()
    expect(errors).toEqual([]) // the initial cbofs load succeeds — no error

    m.pan(SF_BAY) // 502s
    await flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]![0]).toBe('sfbofs')
    expect(errors[0]![1]).toBeInstanceOf(Error)

    m.pan(SF_BAY) // retry — succeeds this time, no additional error
    await flush()
    expect(errors).toHaveLength(1)
  })

  it('survives a failed fetch — keeps the current cell, retries on the next pan', async () => {
    let failNext = true
    const failing = (async (url: string) => {
      const key = /latest\/(\w+)\.h5/.exec(url)![1]!
      if (key === 'sfbofs' && failNext) {
        failNext = false
        return new Response('', { status: 502 })
      }
      return new Response(new TextEncoder().encode(key), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: failing })
    await flush()
    m.pan(SF_BAY) // sfbofs fetch 502s → revert, no swap, no throw
    await flush()
    expect(h.current()).toBe('cbofs')
    expect(m.armed).toEqual(['cbofs'])
    m.pan(SF_BAY) // retry — succeeds this time
    await flush()
    expect(h.current()).toBe('sfbofs')
    expect(m.armed).toEqual(['cbofs', 'sfbofs'])
  })

  it('remove() detaches the move-end listener', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    h.remove()
    expect(m.hasListener()).toBe(false)
    m.pan(SF_BAY) // listener gone → no effect
    await flush()
    expect(f.fetched).toEqual(['cbofs'])
  })

  it('setTime re-decodes the current region cell at a group — no re-fetch (#1272 E-③)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')

    h.setTime(3) // forecast hour 3 → 1-based group 4
    await flush()
    expect(f.fetched).toEqual(['cbofs']) // NO extra fetch — cached bytes reused
    expect(m.armed).toEqual(['cbofs', 'cbofs']) // re-decoded the same region cell
    const last = m.armedOpts[m.armedOpts.length - 1]
    expect(last?.group).toBe(4)
    expect(last?.url).toMatch(/latest\/cbofs\.h5$/)
  })

  it('setTime is a no-op before a region has loaded', async () => {
    const f = countingFetch()
    const m = makeMap(MID_PACIFIC) // open ocean → no covering model loads
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBeNull()
    h.setTime(2)
    await flush()
    expect(m.armed).toEqual([]) // nothing loaded → nothing to re-decode
  })

  // #1333 — peekTime: the zero-network decode-without-display a caller blends against
  // (interpolateVectorCoverage) before pushing the result itself (setCoverageFrame).
  it('peekTime resolves null before a region has loaded — no crash, no fetch', async () => {
    const f = countingFetch()
    const m = makeMap(MID_PACIFIC)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(await h.peekTime(2)).toBeNull()
    expect(f.fetched).toEqual([]) // still no fetch — open ocean, nothing cached
  })

  it('peekTime never fetches (reuses the cached bytes) and never arms the display', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')
    await h.peekTime(5)
    expect(f.fetched).toEqual(['cbofs']) // no SECOND fetch for the peek
    expect(m.armed).toEqual(['cbofs']) // peek never calls setCoverageData — nothing re-armed
  })

  it('peekTime resolves null (never throws) if the cached bytes fail to decode', async () => {
    // countingFetch's stub bytes are the UTF-8 model key, not a real HDF5 cell — decoding
    // MUST fail, and peekTime's contract is to swallow that into null, exactly like a real
    // corrupt-cell failure should behave for a caller that's just probing ahead.
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    await expect(h.peekTime(1)).resolves.toBeNull()
  })

  // #1333 — the mosaic's OWN reported bug: a pure ZOOM (no pan) near the cbofs/dbofs boundary
  // used to flip `current` on every such zoom (bestModelForBounds had no hysteresis), firing a
  // hard coverage swap — wiping every arrow — for a screen that mostly didn't move. Same witness
  // bounds as the s111-models.test.ts hysteresis suite, centred on the cbofs/dbofs shared zone.
  it('a boundary-adjacent zoom-in (same centre) does NOT flip the resident region (#1333)', async () => {
    const WIDE: LngLatBounds = [
      [-76.9, 37.3],
      [-73.9, 40.3],
    ] // half-extent 1.5° — cbofs wins outright
    const ZOOMED_IN: LngLatBounds = [
      [-75.7, 38.5],
      [-75.1, 39.1],
    ] // SAME centre, half-extent 0.3° — a tie without hysteresis, resolving to dbofs (the bug)
    const f = countingFetch()
    const m = makeMap(WIDE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')

    m.pan(ZOOMED_IN) // a zoom, routed through the SAME moveend listener as a pan
    await flush()
    expect(h.current()).toBe('cbofs') // stays — no flip to dbofs
    expect(f.fetched).toEqual(['cbofs']) // no second fetch
    expect(m.armed).toEqual(['cbofs']) // no re-arm / no arrow wipe
  })

  // demo-runner's real call site passes NO `fetch` option (proxyBase only) — installS111Mosaic
  // then defaults to `globalThis.fetch`. A real browser's `fetch` only accepts a call whose
  // `this` is the `Window`/`WorkerGlobalScope` that owns it; reading the property into this
  // module's local `doFetch` const and invoking it as a bare identifier drops that receiver,
  // which throws "Illegal invocation" — invisible to Node/Bun's fetch (no such check), so
  // this stayed uncaught until a real browser. The stub is a RAW (unbound) function assigned
  // directly as `globalThis.fetch`, failing unless invoked with `this === globalThis` — the
  // same property-access-vs-bare-call distinction a real Window enforces.
  it('defaults to globalThis.fetch WITHOUT detaching it (browser Illegal-invocation regression)', async () => {
    const realFetch = globalThis.fetch
    const backing = countingFetch().fetch
    // @ts-expect-error — stubbing the global for this one assertion
    globalThis.fetch = function (this: unknown, url: string, init?: RequestInit) {
      if (this !== globalThis)
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      return backing(url, init)
    }
    try {
      const m = makeMap(CHESAPEAKE)
      const h = installS111Mosaic(m.map, { sourceId: 'currents' }) // no `fetch` — the real default path
      await flush()
      expect(h.current()).toBe('cbofs')
      expect(m.armed).toEqual(['cbofs'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

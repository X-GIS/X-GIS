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
// The cbofs/dbofs shared zone — same witness bounds as the s111-models hysteresis suite.
// Both views overlap BOTH domains, which is the whole point: the resident set is identical
// either side of the zoom, so a boundary zoom can no longer wipe anything.
const WIDE: LngLatBounds = [
  [-76.9, 37.3],
  [-73.9, 40.3],
] // half-extent 1.5° — cbofs wins the primary outright
const ZOOMED_IN: LngLatBounds = [
  [-75.7, 38.5],
  [-75.1, 39.1],
] // SAME centre, half-extent 0.3° — primary would tip to dbofs without hysteresis

function makeMap(initial: LngLatBounds) {
  let bounds = initial
  let listener: (() => void) | null = null
  const armed: string[] = [] // model key of each setCoverageData call, in order
  const armedOpts: ({ url?: string; group?: number; region?: string } | undefined)[] = []
  const removed: string[] = [] // region keys dropped via removeCoverageRegion
  /** The regions the MAP believes are resident — armed minus removed. The mosaic's own
   *  `regions()` is its intent; this is what actually reached the engine, so a test that
   *  checks both cannot be fooled by the mosaic bookkeeping a region it never pushed. */
  const live = new Set<string>()
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
      if (opts?.region) live.add(opts.region)
    },
    removeCoverageRegion: (_id, region) => {
      removed.push(region)
      live.delete(region)
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
    removed,
    live: () => [...live].sort(),
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
  // THE REPORTED BUG: several S-111 domains were never visible at once. The mosaic picked the
  // single best-covering model and REPLACED the resident cell on every move-end, so a viewport
  // straddling two NOAA domains showed one of them and a blank half. Every assertion about a
  // multi-model viewport below exists because of that report.
  it('THE FIX: a viewport spanning two domains ends with BOTH resident', async () => {
    const f = countingFetch()
    const m = makeMap(WIDE) // straddles cbofs and dbofs
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.regions().sort()).toEqual(['cbofs', 'dbofs'])
    expect(f.fetched.sort()).toEqual(['cbofs', 'dbofs'])
    // …and both actually reached the engine, each under its own region key.
    expect(m.live()).toEqual(['cbofs', 'dbofs'])
    expect(m.armedOpts.map((o) => o?.region).sort()).toEqual(['cbofs', 'dbofs'])
  })

  it('a nested pair loads together, local model primary (SF Bay is inside sfbofs AND wcofs)', async () => {
    const f = countingFetch()
    const m = makeMap(SF_BAY)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    // Both fully contain the view, so overlap ties; the SMALLER (higher-resolution) domain is
    // the primary, matching what the single-model selector always picked.
    expect(h.current()).toBe('sfbofs')
    expect(h.regions().sort()).toEqual(['sfbofs', 'wcofs'])
  })

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
    // cbofs left the viewport → dropped, not merely shadowed. Residency tracks what is
    // actually on screen; keeping a whole east-coast domain loaded while looking at
    // California is what the byte budget exists to prevent.
    expect(m.removed).toEqual(['cbofs'])
    expect(m.live()).toEqual(['sfbofs', 'wcofs'])
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
    // cbofs was cached → NOT fetched again, but IS re-armed. (sfbofs/wcofs come from the SF
    // view; the point here is that returning to cbofs costs no network.)
    expect(f.fetched.filter((k) => k === 'cbofs')).toEqual(['cbofs'])
    expect(m.armed.filter((k) => k === 'cbofs')).toEqual(['cbofs', 'cbofs'])
  })

  it('drops everything over open ocean (no covering model)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    m.pan(MID_PACIFIC)
    await flush()
    // Behaviour CHANGE, and deliberate: the old mosaic left the last covering model armed, so
    // panning to mid-Pacific kept drawing Chesapeake currents off-screen forever. Nothing
    // overlaps here, so nothing should be resident.
    expect(h.regions()).toEqual([])
    expect(h.current()).toBeNull()
    expect(m.live()).toEqual([])
    expect(f.fetched).toEqual(['cbofs']) // no fetch over open ocean
  })

  it('honours the resident BYTE budget, keeping the most relevant domains', async () => {
    const f = countingFetch()
    const m = makeMap(WIDE) // cbofs + dbofs overlap
    // Below one nominal cell (10 MB), so only the primary survives the prefix — the budget is
    // a cap on bytes, never a promise that every overlapping domain loads.
    const h = installS111Mosaic(m.map, {
      sourceId: 'currents',
      fetch: f.fetch,
      maxResidentBytes: 1024,
    })
    await flush()
    expect(h.regions()).toEqual(['cbofs']) // the primary, not an arbitrary one
    expect(f.fetched).toEqual(['cbofs']) // the dropped domain is never even fetched
  })

  it('evicts the least-recently-used cell past maxCached', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, maxCached: 1 })
    await flush()
    m.pan(SF_BAY) // loads sfbofs + wcofs, evicting cbofs from the 1-entry byte cache
    await flush()
    m.pan(CHESAPEAKE) // cbofs evicted → must re-fetch
    await flush()
    // Asserted on cbofs alone: how many OTHER cells the SF view happens to pull is the
    // selection rule's business, not the cache's, and pinning the whole list here would make
    // this test fail for a reason that has nothing to do with eviction.
    expect(f.fetched.filter((k) => k === 'cbofs')).toEqual(['cbofs', 'cbofs'])
  })

  it('fires onSwap per region that lands (overlay re-arm hook)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const swaps: string[] = []
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, onSwap: (k) => swaps.push(k) })
    await flush()
    expect(swaps).toEqual(['cbofs'])
    m.pan(SF_BAY)
    await flush()
    // One per REGION now, not one per swap — the SF view loads two nested domains.
    expect(swaps.slice(1).sort()).toEqual(['sfbofs', 'wcofs'])
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
    expect(starts.slice(1).sort()).toEqual(['sfbofs', 'wcofs']) // both new regions fetch

    m.pan(CHESAPEAKE) // back to a cached cell — NO fetch, so no loading start
    await flush()
    expect(starts).toHaveLength(3)
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
    m.pan(SF_BAY) // sfbofs 502s; its NEIGHBOUR wcofs still loads — no throw
    await flush()
    // The surviving region is what matters: one domain failing must not blank the view. (The
    // old single-region mosaic had nothing to fall back to, so it reverted to the off-screen
    // cbofs instead — which drew east-coast currents over California.)
    expect(h.regions()).toEqual(['wcofs'])
    expect(m.live()).toEqual(['wcofs'])
    m.pan(SF_BAY) // retry — sfbofs succeeds this time and joins its neighbour
    await flush()
    expect(h.regions().sort()).toEqual(['sfbofs', 'wcofs'])
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
    expect(last?.region).toBe('cbofs') // re-armed IN PLACE, not as a new region
  })

  it('setTime steps EVERY resident region to the same hour', async () => {
    // Stepping only the primary would leave the neighbour frozen an hour behind, drawing as a
    // current discontinuity right along the domain boundary — a plausible-looking lie.
    const f = countingFetch()
    const m = makeMap(WIDE) // cbofs + dbofs
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.regions().sort()).toEqual(['cbofs', 'dbofs'])
    const before = m.armedOpts.length

    await h.setTime(3)
    const stepped = m.armedOpts.slice(before)
    expect(stepped.map((o) => o?.region).sort()).toEqual(['cbofs', 'dbofs'])
    expect(stepped.every((o) => o?.group === 4)).toBe(true) // the SAME hour for both
    expect(f.fetched.sort()).toEqual(['cbofs', 'dbofs']) // still zero network for the step
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
  //
  // Loading BOTH domains makes the wipe structurally impossible rather than merely damped:
  // the resident set is {cbofs, dbofs} on either side of the zoom, so there is nothing left to
  // swap out. The hysteresis now only steadies which one is PRIMARY (the forecast-time axis).
  it('a boundary-adjacent zoom-in (same centre) disturbs NOTHING (#1333)', async () => {
    const f = countingFetch()
    const m = makeMap(WIDE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')
    expect(h.regions().sort()).toEqual(['cbofs', 'dbofs'])
    const armedBefore = m.armed.length

    m.pan(ZOOMED_IN) // a zoom, routed through the SAME moveend listener as a pan
    await flush()
    expect(h.current()).toBe('cbofs') // primary stays — no flip to dbofs
    expect(h.regions().sort()).toEqual(['cbofs', 'dbofs']) // set unchanged
    expect(m.removed).toEqual([]) // nothing evicted → no arrow wipe
    expect(m.armed).toHaveLength(armedBefore) // no re-arm at all
    expect(f.fetched.sort()).toEqual(['cbofs', 'dbofs']) // no second fetch
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

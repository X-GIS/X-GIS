// Reproduce tests for three surgical fixes in vector-tile-loader.ts:
//
//   FIX 1 — tileFetchNegativeCache unbounded growth. Every z/x/y is a
//           distinct URL, so panning across a broken region inserts one
//           entry per tile that is never revisited. Without a bound the
//           module-scoped Map grows for the page lifetime. The fix sweeps
//           expired entries on each insert and enforces a hard FIFO cap.
//
//   FIX 2 — abort-listener leak per backoff sleep. The retry backoff sleep
//           added an 'abort' listener with {once:true}; {once} only auto-
//           removes after the abort event FIRES, so a normal timer-fire
//           (resolve) left the listener lingering on the signal until the
//           controller was GC'd. The fix removes the listener on the
//           resolve path too.
//
//   FIX 3 — tileFetchLogThrottle defeated by query-param templates, and
//           unbounded. The throttle key only collapsed a PATH-shaped
//           /z/x/y run, so a "?z=..&x=..&y=.." template kept a distinct key
//           per tile and every failing tile warned. The same Map also had
//           no sweep and no cap. The fix collapses digit runs in the query
//           string too and bounds the Map the way its negative-cache
//           sibling already is.
//
// Every fix is driven through the PUBLIC TileJSONSource fetcher (which
// calls the module-private fetchTileWithRetry). A {z}/{x}/{y} template
// makes openTileJSON synthesize an in-memory manifest — NO network — so
// the fetcher is reachable without a real tile server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLogSink } from '@xgis/shared'
import {
  TileJSONSource,
  VectorTileLoader,
  __tileFetchNegativeCacheSizeForTest,
  __resetTileFetchNegativeCacheForTest,
  __tileFetchLogThrottleSizeForTest,
  __resetTileFetchLogThrottleForTest,
} from '@xgis/data'

// The negative cache is process-wide (module-scoped). Reset before each
// test so entries from one case don't bleed into the next.
beforeEach(() => __resetTileFetchNegativeCacheForTest())
afterEach(() => __resetTileFetchNegativeCacheForTest())

/** Build a TileJSONSource fetcher for a private-host {z}/{x}/{y} template.
 *  A private host means the per-tile URL trips assertSafeRemoteUrl → the
 *  SSRF-reject insert path runs (negativeCacheSet) and 'failed' is returned
 *  WITHOUT any network access. Distinct (z,x,y) → distinct URLs → distinct
 *  inserts, exactly the panning-across-a-broken-region flood the bound is
 *  for. */
async function makePrivateHostFetcher() {
  const loader = new VectorTileLoader()
  // 10.0.0.0/8 is RFC-1918 private → assertSafeRemoteUrl rejects every
  // substituted URL. {z}/{x}/{y} makes openTileJSON return a synthetic
  // manifest in-memory (no fetch).
  const src = new TileJSONSource('http://10.0.0.1/{z}/{x}/{y}.mvt', loader)
  const resolved = await src.resolve()
  expect(resolved).not.toBeNull()
  return resolved!.fetcher
}

/** A never-aborting AbortSignal that records every add/removeEventListener
 *  for the 'abort' event, so we can assert listeners are balanced. */
function makeRecordingSignal() {
  const added: EventListenerOrEventListenerObject[] = []
  const removed: EventListenerOrEventListenerObject[] = []
  const signal = {
    aborted: false,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      if (type === 'abort') added.push(fn)
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      if (type === 'abort') removed.push(fn)
    },
  } as unknown as AbortSignal
  return { signal, added, removed }
}

describe('FIX 1 — tileFetchNegativeCache is bounded', () => {
  it('stays ≤ the hard cap under a flood of distinct failing URLs', async () => {
    const fetcher = await makePrivateHostFetcher()
    const signal = new AbortController().signal
    // Drive far more distinct (z,x,y) than the 4096 cap. Each is a unique
    // private-host URL → one SSRF-reject insert apiece. Before the fix the
    // size would equal the number of distinct URLs (≈ 6000); after the fix
    // FIFO eviction keeps it pinned at the cap.
    let z = 5
    for (let i = 0; i < 6000; i++) {
      const x = i & 0x3ff // 0..1023
      const y = (i >> 10) & 0xff
      if ((i & 0xfff) === 0) z++
      const r = await fetcher(z, x * 7 + i, y * 11 + i, signal)
      expect(r).toBe('failed')
    }
    const size = __tileFetchNegativeCacheSizeForTest()
    expect(size).toBeLessThanOrEqual(4096)
    // Sanity: it actually filled up to the cap (not trivially small),
    // proving the eviction — not a lack of inserts — is what bounds it.
    expect(size).toBe(4096)
  })

  it('sweeps expired entries on a later insert (TTL-bounded)', async () => {
    const fetcher = await makePrivateHostFetcher()
    const signal = new AbortController().signal
    vi.useFakeTimers()
    try {
      // t0: insert a handful of distinct failing URLs.
      vi.setSystemTime(new Date(0))
      for (let i = 0; i < 50; i++) await fetcher(5, i, 0, signal)
      expect(__tileFetchNegativeCacheSizeForTest()).toBe(50)
      // Advance Date.now() well past the 5-minute TTL, then do ONE more
      // insert. negativeCacheSet sweeps every entry whose expiry has passed
      // before adding the new one → only the fresh entry survives.
      vi.setSystemTime(new Date(6 * 60_000))
      await fetcher(5, 9999, 0, signal)
      expect(__tileFetchNegativeCacheSizeForTest()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FIX 2 — backoff sleep removes its abort listener on resolve', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('balances addEventListener/removeEventListener when the timer fires', async () => {
    const { signal, added, removed } = makeRecordingSignal()

    // A PUBLIC-host fetcher so assertSafeRemoteUrl passes and we reach the
    // real retry loop. Stub global fetch: first attempt → retryable HTTP
    // 500 (drives a backoff sleep), second attempt → 200 OK with bytes.
    const loader = new VectorTileLoader()
    const src = new TileJSONSource('https://tiles.example.com/{z}/{x}/{y}.mvt', loader)
    const resolved = await src.resolve()
    const publicFetcher = resolved!.fetcher

    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      if (call === 1) return new Response('', { status: 500 })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    vi.useFakeTimers()
    try {
      const p = publicFetcher(5, 1, 1, signal)
      // First attempt fails (500) → enters the backoff sleep, which adds an
      // 'abort' listener and arms a setTimeout. Flush the timer so the sleep
      // RESOLVES (the leak path: {once} would NOT auto-remove here).
      await vi.runAllTimersAsync()
      const r = await p
      expect(r).toEqual(new Uint8Array([1, 2, 3]))
    } finally {
      vi.useRealTimers()
    }

    // Exactly one backoff sleep occurred (one retry). Before the fix: the
    // listener was added but never removed on the resolve path → added=1,
    // removed=0. After the fix: added and removed are balanced.
    expect(added.length).toBeGreaterThanOrEqual(1)
    expect(removed.length).toBe(added.length)
    // Same fn object added and later removed.
    expect(removed[0]).toBe(added[0])
  })
})

describe('FIX 3 — tile-fetch log throttle survives templates and stays bounded', () => {
  let originalFetch: typeof globalThis.fetch
  const warns: string[] = []

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Permanently-500 upstream: every tile exhausts all 3 attempts and
    // reaches the throttled warn.
    globalThis.fetch = (async () =>
      new Response('', { status: 500 })) as unknown as typeof globalThis.fetch
    warns.length = 0
    setLogSink((level, message) => {
      if (level === 'warn') warns.push(message)
    })
    __resetTileFetchLogThrottleForTest()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    setLogSink(null)
    __resetTileFetchLogThrottleForTest()
  })

  /** Fetcher for a PUBLIC-host template, so assertSafeRemoteUrl passes and
   *  the real retry loop (and therefore the throttled warn) is reached. */
  async function publicFetcherFor(template: string) {
    const src = new TileJSONSource(template, new VectorTileLoader())
    const resolved = await src.resolve()
    expect(resolved).not.toBeNull()
    return resolved!.fetcher
  }

  /** Drive one tile to exhaustion. Only setTimeout is faked so the two
   *  backoff sleeps flush instantly while Date.now() stays REAL — the whole
   *  loop then sits inside one 60 s throttle window, which is exactly the
   *  upstream-outage burst the throttle exists for. */
  async function failTile(
    fetcher: (z: number, x: number, y: number, s: AbortSignal) => Promise<unknown>,
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ) {
    const p = fetcher(z, x, y, signal)
    await vi.runAllTimersAsync()
    expect(await p).toBe('failed')
  }

  it('emits ONE warn for N failing tiles behind a query-param template', async () => {
    // No path-shaped /z/x/y run here: pre-fix the key stayed the FULL URL,
    // so all 25 distinct tiles got 25 distinct keys and 25 warns.
    const fetcher = await publicFetcherFor('https://tiles.example.com/t?z={z}&x={x}&y={y}')
    const signal = new AbortController().signal
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (let i = 0; i < 25; i++) await failTile(fetcher, 5, i, 0, signal)
    } finally {
      vi.useRealTimers()
    }
    expect(warns.length).toBe(1)
    expect(__tileFetchLogThrottleSizeForTest()).toBe(1)
  })

  it('stays ≤ the hard cap under a flood of distinct failing URL patterns', async () => {
    const signal = new AbortController().signal
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // 300 sources with digit-free, distinct path prefixes → 300 distinct
      // throttle keys that the digit collapsing cannot merge. Pre-fix the
      // Map just grew to 300 (and would keep growing for the page lifetime).
      for (let i = 0; i < 300; i++) {
        const seg = `s${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`
        const fetcher = await publicFetcherFor(`https://tiles.example.com/${seg}/{z}/{x}/{y}.mvt`)
        await failTile(fetcher, 5, 0, 0, signal)
      }
    } finally {
      vi.useRealTimers()
    }
    const size = __tileFetchLogThrottleSizeForTest()
    expect(size).toBeLessThanOrEqual(256)
    // Sanity: it actually filled up to the cap (not trivially small),
    // proving the eviction — not a lack of inserts — is what bounds it.
    expect(size).toBe(256)
  })

  it('sweeps entries whose throttle window has already elapsed', async () => {
    const signal = new AbortController().signal
    // Date is faked here too so the 60 s window can be stepped over.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const t0 = Date.UTC(2026, 0, 1)
      vi.setSystemTime(t0)
      await failTile(
        await publicFetcherFor('https://tiles.example.com/aa/{z}/{x}/{y}.mvt'),
        5,
        0,
        0,
        signal,
      )
      expect(__tileFetchLogThrottleSizeForTest()).toBe(1)
      // Past the window a DIFFERENT pattern fails. Its insert sweeps the
      // stale entry first — that entry could never suppress a warn again.
      vi.setSystemTime(t0 + 2 * 60_000)
      await failTile(
        await publicFetcherFor('https://tiles.example.com/bb/{z}/{x}/{y}.mvt'),
        5,
        0,
        0,
        signal,
      )
      expect(__tileFetchLogThrottleSizeForTest()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

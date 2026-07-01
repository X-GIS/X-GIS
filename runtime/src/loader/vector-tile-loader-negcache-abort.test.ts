// Reproduce tests for two surgical fixes in vector-tile-loader.ts:
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
// Both fixes are driven through the PUBLIC TileJSONSource fetcher (which
// calls the module-private fetchTileWithRetry). A {z}/{x}/{y} template
// makes openTileJSON synthesize an in-memory manifest — NO network — so
// the fetcher is reachable without a real tile server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TileJSONSource,
  VectorTileLoader,
  __tileFetchNegativeCacheSizeForTest,
  __resetTileFetchNegativeCacheForTest,
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
      const x = i & 0x3ff       // 0..1023
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

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

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

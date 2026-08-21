// Fail-before test for #1269 item 3 — vector-tile retry backoff jitter.
//
// Before this fix, `fetchTileWithRetry`'s backoff schedule was the fixed
// `[300, 900]` array (vector-tile-loader.ts): every tile that failed in the
// same tick slept for EXACTLY the same duration and therefore retried in
// lockstep — a thundering herd against a server that is likely already
// struggling. The fix (`jitteredBackoffMs`) samples a delay uniformly on
// `[base/2, base)` per attempt (EQUAL jitter, not full jitter — see the
// doc comment on jitteredBackoffMs for why: 3 fixed attempts + a 5-minute
// exhaustion penalty make the guaranteed floor load-bearing) via an
// injectable randomness seam (`__setTileRetryRandomForTest`), so
// concurrently-failing tiles spread their retries out instead of
// re-requesting all at once.
//
// A test that only checks "a delay happened" would pass on the UNFIXED
// code too (it also delays, just by a constant). To be non-vacuous this
// test asserts DISTINCTNESS: with a deterministic injected rng returning a
// distinct value per call, N concurrently-failing tiles must produce N
// pairwise-distinct backoff delays. Toggling the retry loop back to the
// unfixed `backoffsMs[attempt]` (no jitter call) collapses that same
// assertion to N IDENTICAL delays and this test goes red — see the
// verbatim failure transcript in the PR/issue history for #1269.
//
// Driven through the PUBLIC TileJSONSource fetcher (never fetchTileWithRetry
// directly), same idiom as vector-tile-loader-negcache-abort.test.ts: a
// {z}/{x}/{y} template makes openTileJSON synthesize an in-memory manifest
// (no network), and a stubbed global fetch drives the retry loop.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TileJSONSource,
  VectorTileLoader,
  __setTileRetryRandomForTest,
  __resetTileRetryRandomForTest,
  __resetTileFetchNegativeCacheForTest,
} from '@xgis/data'

beforeEach(() => {
  __resetTileFetchNegativeCacheForTest()
  __resetTileRetryRandomForTest()
})
afterEach(() => {
  __resetTileFetchNegativeCacheForTest()
  __resetTileRetryRandomForTest()
})

/** Build a TileJSONSource fetcher for a PUBLIC-host {z}/{x}/{y} template, so
 *  assertSafeRemoteUrl passes and the real retry loop (and therefore the
 *  real backoff sleep) is reached. */
async function publicFetcherFor(template: string) {
  const src = new TileJSONSource(template, new VectorTileLoader())
  const resolved = await src.resolve()
  expect(resolved).not.toBeNull()
  return resolved!.fetcher
}

/** Replace global setTimeout with a stub that (a) records every requested
 *  delay in call order and (b) invokes the callback immediately, so the
 *  retry loop's backoff sleeps resolve without a real wait and without
 *  needing vi.useFakeTimers()/runAllTimersAsync — this test only cares
 *  about the MS ARGUMENT each sleep was armed with, not wall-clock time.
 *  Restores the original on return of the callback passed in. */
function recordSetTimeoutDelays(): { delays: number[]; restore: () => void } {
  const delays: number[] = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    delays.push(ms ?? 0)
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof globalThis.setTimeout
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = original
    },
  }
}

describe('#1269 item 3 — vector-tile retry backoff jitter', () => {
  it('N concurrently-failing tiles produce N pairwise-distinct backoff delays, each within [150, 300)', async () => {
    const N = 8
    // Distinct injected values on (0, 1), strictly increasing → the resulting
    // delays (150 + value * 150, an affine — hence order-preserving and
    // injective — map of value) are pairwise distinct BY CONSTRUCTION, so
    // the assertion below is not a probabilistic "very likely" check.
    const rngValues = Array.from({ length: N }, (_, i) => (i + 1) / (N + 1))
    let rngCall = 0
    __setTileRetryRandomForTest(() => rngValues[rngCall++ % rngValues.length])

    // Per-URL call counter: 1st request for a given tile URL fails (500,
    // drives exactly one backoff sleep at attempt 0, base=300ms), 2nd
    // request for that same URL succeeds — so each of the N tiles below
    // produces EXACTLY one recorded backoff delay, all at the same base.
    const callCountByUrl = new Map<string, number>()
    globalThis.fetch = (async (url: string | URL) => {
      const key = String(url)
      const n = (callCountByUrl.get(key) ?? 0) + 1
      callCountByUrl.set(key, n)
      if (n === 1) return new Response('', { status: 500 })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const { delays, restore } = recordSetTimeoutDelays()
    try {
      const fetcher = await publicFetcherFor('https://tiles.example.com/{z}/{x}/{y}.mvt')
      const signal = new AbortController().signal
      // "Concurrently failing": N distinct tiles all in flight together via
      // Promise.all, exactly the thundering-herd shape #1269 describes.
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => fetcher(5, i, 0, signal)),
      )
      for (const r of results) expect(r).toEqual(new Uint8Array([1, 2, 3]))
    } finally {
      restore()
    }

    // One backoff sleep per tile.
    expect(delays.length).toBe(N)
    // THE non-vacuous check: N pairwise-distinct delays. On the unfixed
    // fixed [300, 900] schedule every entry here is exactly 300 — this
    // assertion is what turns red on that code (see file header + report).
    expect(new Set(delays).size).toBe(N)
    // Bound (design constraint 2, equal jitter): uniform on [base/2, base),
    // so every delay for this attempt (base=300) must be >= 150 AND < 300.
    // The floor half of this is the one full jitter (uniform on [0, base))
    // would violate — see the two dedicated floor/ceiling tests below for
    // the fail-before on that specific regression.
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(150)
      expect(d).toBeLessThan(300)
    }
  })

  // THE test that catches a revert to full jitter: at rng()=0, equal jitter's
  // floor (base/2) still fires, while full jitter would collapse to 0 — the
  // exact "both attempts land near zero simultaneously" case the review
  // proof (r1=r2=0.05 -> 60ms total retry window) is built on.
  it('pins the floor at base/2 for both backoff steps when rng() -> 0', async () => {
    __setTileRetryRandomForTest(() => 0)

    globalThis.fetch = (async () =>
      new Response('', { status: 500 })) as unknown as typeof globalThis.fetch

    const { delays, restore } = recordSetTimeoutDelays()
    try {
      const fetcher = await publicFetcherFor('https://tiles.example.com/{z}/{x}/{y}.mvt')
      const signal = new AbortController().signal
      const result = await fetcher(5, 1, 1, signal)
      expect(result).toBe('failed')
    } finally {
      restore()
    }

    expect(delays.length).toBe(2)
    // attempt 0, base=300 -> floor is base/2 = 150, NOT 0.
    expect(delays[0]).toBe(150)
    // attempt 1, base=900 -> floor is base/2 = 450, NOT 0.
    expect(delays[1]).toBe(450)
  })

  it('pins the ceiling below base for both backoff steps when rng() -> just-under-1', async () => {
    __setTileRetryRandomForTest(() => 0.999999)

    globalThis.fetch = (async () =>
      new Response('', { status: 500 })) as unknown as typeof globalThis.fetch

    const { delays, restore } = recordSetTimeoutDelays()
    try {
      const fetcher = await publicFetcherFor('https://tiles.example.com/{z}/{x}/{y}.mvt')
      const signal = new AbortController().signal
      const result = await fetcher(5, 1, 1, signal)
      expect(result).toBe('failed')
    } finally {
      restore()
    }

    expect(delays.length).toBe(2)
    // attempt 0, base=300, rng≈1 -> approaches 300 but never reaches it.
    expect(delays[0]).toBeGreaterThan(299)
    expect(delays[0]).toBeLessThan(300)
    // attempt 1, base=900, rng≈1 -> approaches 900 but never reaches it.
    expect(delays[1]).toBeGreaterThan(899)
    expect(delays[1]).toBeLessThan(900)
  })

  it('a single failing tile still resolves via exactly one jittered sleep before succeeding', async () => {
    // Sanity check that jitter doesn't disturb the pre-existing single-tile
    // retry-then-succeed path (mirrors FIX 2 in
    // vector-tile-loader-negcache-abort.test.ts, now under an injected rng
    // instead of the real one).
    __setTileRetryRandomForTest(() => 0.5)

    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      if (call === 1) return new Response('', { status: 500 })
      return new Response(new Uint8Array([9, 9]), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const { delays, restore } = recordSetTimeoutDelays()
    try {
      const fetcher = await publicFetcherFor('https://tiles.example.com/{z}/{x}/{y}.mvt')
      const signal = new AbortController().signal
      const result = await fetcher(5, 1, 1, signal)
      expect(result).toEqual(new Uint8Array([9, 9]))
    } finally {
      restore()
    }

    expect(delays).toEqual([225]) // 150 + 0.5 * 150 (base/2 + r * base/2, base=300)
  })
})

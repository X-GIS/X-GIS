// ═══ #1580 leg A — GlyphPbfCache.ranges never capped or evicted ═══
//
// A long session panning across CJK label regions retained EVERY decoded
// glyph range it ever touched — bitmaps included — with no cap and no path
// that ever dropped one short of `map.destroy()`. Gave `ranges` a
// byte-capped LRU over `loaded` entries, mirroring the tile-cache pattern
// (raster-cache-budget.ts): a miss on an evicted range just refetches.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlyphPbfCache } from './glyph-pbf-cache'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = readFileSync(FIXTURE)

function mockFetchOK(urls: string[]): typeof globalThis.fetch {
  return (input: RequestInfo | URL): Promise<Response> => {
    urls.push(typeof input === 'string' ? input : input.toString())
    return Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
  }
}

const URL_TEMPLATE = 'https://example.com/font/{fontstack}/{range}.pbf'

/** Every call decodes the SAME fixture, so every distinct fontstack name
 *  produces a same-size 'loaded' range under a distinct cache key
 *  (rangeKey is `${fontstack} ${rangeStart}`). */
async function loadRange(cache: GlyphPbfCache, fontstack: string): Promise<void> {
  await new Promise<void>((resolve) => cache.ensure(fontstack, 0x41, resolve))
}

interface CachePrivates {
  ranges: Map<string, { status: string }>
  retainedBytes: number
}
const privatesOf = (c: GlyphPbfCache): CachePrivates => c as unknown as CachePrivates

describe('#1580 leg A — GlyphPbfCache evicts loaded ranges past a byte budget', () => {
  it('LRU-evicts the oldest ranges once retained bytes cross the cap', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    const priv = privatesOf(cache)

    // Load one range to measure its real decoded size, then compute how many
    // distinct ranges cross MAX_RETAINED_BYTES (32 MiB) — no magic N.
    await loadRange(cache, 'f0')
    const bytesPerRange = priv.retainedBytes
    expect(bytesPerRange, 'premise: the fixture decodes to a non-trivial size').toBeGreaterThan(0)
    const capBytes = 32 * 1024 * 1024
    const n = Math.ceil(capBytes / bytesPerRange) + 5

    for (let i = 1; i < n; i++) await loadRange(cache, `f${i}`)

    expect(priv.retainedBytes, 'must drain back under the byte budget').toBeLessThanOrEqual(
      capBytes,
    )
    expect(priv.ranges.size, 'some ranges must have been evicted').toBeLessThan(n)

    // The FIRST range loaded is the least-recently-used — it must have been
    // evicted, so re-ensuring it issues a fresh fetch.
    const urlsBefore = urls.length
    await loadRange(cache, 'f0')
    expect(urls.length, 'the evicted range must refetch on the next ensure()').toBe(urlsBefore + 1)

    // CONTROL — the MOST recently loaded range must still be resident (no
    // fetch on re-ensure), or eviction is indiscriminate rather than LRU.
    const urlsBeforeLast = urls.length
    await loadRange(cache, `f${n - 1}`)
    expect(urls.length, 'the most-recent range must still be cached').toBe(urlsBeforeLast)
  })

  it('CONTROL — get() bumps LRU, protecting a touched range from eviction', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    const priv = privatesOf(cache)

    await loadRange(cache, 'f0')
    const bytesPerRange = priv.retainedBytes
    const capBytes = 32 * 1024 * 1024
    const capRanges = Math.floor(capBytes / bytesPerRange)

    // Load comfortably under budget (no eviction yet) — f0 plus enough peers
    // that f1 is NOT the most-recently-loaded when the batch below fires.
    for (let i = 1; i < capRanges - 3; i++) await loadRange(cache, `f${i}`)
    expect(priv.ranges.size, 'premise: nothing evicted yet').toBe(capRanges - 3)

    // Touch f0 (currently the OLDEST entry) — bumps it to the back, ahead of
    // f1..f(capRanges-4), which stay in their original (older) order.
    cache.get('f0', 0x41)

    // Push well over budget — forces eviction of several oldest entries.
    // f0 must NOT be among them (it was just bumped); f1 must be, since it
    // is now the oldest surviving entry.
    for (let i = capRanges - 3; i < capRanges + 3; i++) await loadRange(cache, `f${i}`)
    expect(priv.retainedBytes, 'premise: eviction actually fired').toBeLessThanOrEqual(capBytes)

    const urlsBeforeF0 = urls.length
    await loadRange(cache, 'f0')
    expect(urls.length, 'the touched range must survive eviction').toBe(urlsBeforeF0)

    const urlsBeforeF1 = urls.length
    await loadRange(cache, 'f1')
    expect(urls.length, 'its untouched, equally-old peer must have been evicted').toBe(
      urlsBeforeF1 + 1,
    )
  })
})

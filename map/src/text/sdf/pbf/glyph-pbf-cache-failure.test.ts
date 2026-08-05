// ═══ #1574 — one `.catch` was judging three different things ═══
//
// The `.then` body set the range loaded AND ran every queued callback; the trailing
// `.catch` could not tell a fetch/decode failure from a callback throw, and wrote the
// terminal `failed` state either way. Two defects fell out of that one merge:
//
//   A  a FAILED range deleted its pending callbacks WITHOUT firing them, so `onLanded`
//      never ran — no `host.invalidate`, no `markLabelDirty` — and the frame kept
//      believing glyphs were still coming. Composed with the wired metrics-only fallback
//      (all-zero SDF), one blip on range 0-255 left every Latin label correctly spaced
//      and completely inkless for the session, with nothing logged.
//   B  a host `onReady` that THROWS rejected the then-promise and entered that same catch,
//      which overwrote `{status:'loaded', glyphs}` with `{status:'failed'}` — decoded
//      glyphs discarded, remaining callbacks never run, on a range that had loaded fine.
//
// The fix separates them: the catch judges only the fetch/decode chain, the state is
// written before any callback runs, and callbacks are dispatched per-callback in `.finally`
// — mirroring `ListenerRegistry.dispatch` (`layer.ts:602`).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlyphPbfCache } from './glyph-pbf-cache'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The same fixture the sibling rasterizer suite decodes — a real MapLibre glyph range. */
const PBF_BYTES = readFileSync(join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf'))

const URL_TEMPLATE = 'https://x/{fontstack}/{range}.pbf'
const STACK = 'Open Sans Semibold'

/** Let the cache's microtask chain (response → body → decode) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('#1574 A — a failed range still notifies its waiters', () => {
  it('fires the queued callbacks so the caller stops waiting for glyphs', async () => {
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    })
    const fired: string[] = []
    cache.ensure(STACK, 0x41, () => fired.push('a'))
    cache.ensure(STACK, 0x42, () => fired.push('b')) // same range, second waiter

    await settle()

    // Before the fix `pendingCallbacks` was deleted without being run, so BOTH of these
    // were dropped and nothing downstream ever learned the range was dead.
    expect(fired.sort(), 'every waiter on the range is told').toEqual(['a', 'b'])
    expect(cache.isResolved(STACK, 0x41), 'and the range is terminal').toBe(true)
    expect(cache.get(STACK, 0x41)).toBeUndefined()
  })

  it('CONTROL — a successful range still notifies, and serves its glyphs', async () => {
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response(PBF_BYTES, { status: 200 })),
    })
    let fired = 0
    cache.ensure(STACK, 0x41, () => fired++)
    await settle()

    // Without this arm, a cache that fired callbacks and served nothing would pass above.
    expect(fired).toBe(1)
    expect(cache.get(STACK, 0x41), 'the decoded glyph is retrievable').toBeDefined()
  })

  it('a range that has ALREADY failed queues nothing, so the notify cannot loop', async () => {
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    })
    let fired = 0
    cache.ensure(STACK, 0x41, () => fired++)
    await settle()
    expect(fired).toBe(1)

    // This is the re-raster the notification itself provokes. It must be silent, or the
    // invalidate → rasterize → ensure → invalidate cycle runs every frame.
    cache.ensure(STACK, 0x41, () => fired++)
    await settle()
    expect(fired, 'a terminal range does not re-notify').toBe(1)
  })
})

describe('#1574 B — a throwing callback cannot rewrite the load state', () => {
  it('keeps the decoded glyphs and still runs the remaining callbacks', async () => {
    const cache = new GlyphPbfCache({
      glyphsUrl: URL_TEMPLATE,
      fetch: () => Promise.resolve(new Response(PBF_BYTES, { status: 200 })),
    })
    let secondRan = false
    // Two waiters on ONE range; the FIRST throws, as a host-supplied `onReady` may
    // (`map/src/index.ts` exports GlyphPbfCache, `map-types.ts` accepts host providers —
    // a throw from a host hook against a mid-teardown text stage is exactly this window).
    cache.ensure(STACK, 0x41, () => {
      throw new Error('host onReady is buggy')
    })
    cache.ensure(STACK, 0x42, () => {
      secondRan = true
    })

    await settle()

    // Before the fix: the throw rejected the then-promise, the catch stamped `failed` over
    // an already-loaded range, the decoded glyphs were dropped, and the second callback
    // never ran — a network failure invented by a callback that had nothing to do with it.
    expect(cache.get(STACK, 0x41), 'the glyphs that DID arrive are kept').toBeDefined()
    expect(secondRan, 'and a sibling waiter is not collateral').toBe(true)
  })
})

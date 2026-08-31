// ═══ #2116 — `idle` must not mean "converged except for text" ═══
//
// A label whose PBF glyph range is still in flight draws METRICS-ONLY: correctly spaced and
// completely inkless (all-zero SDF), upgraded when `onLanded` fires on a network callback.
// No tile, upload, or LOD signal can see that callback, so the render loop idled on such a
// frame and fired `idle` — and a settle-on-idle harness then sampled first-visit poses
// before their glyphs arrived. That is the whole of `_bundle-replay-parity-gate`'s steps
// 0/1 disagreeing while every REVISITED pose hashed equal.
//
// It was masked, not absent, until #2103: a source whose `maxLevel` sits below `floor(z)`
// (the synthetic earth surface is maxLevel 0 and ships with every globe/background fill)
// pinned `_czPendingAdvance` for the readiness gate's whole 5 s timeout, cleared it for one
// frame and re-armed — which gave every `idle` a 0-5 s delay long enough for glyphs to land.
//
// The predicate added here is BOUNDED, and that is the half these tests exist to defend:
// `safeFetch` has no timeout, so "warm while a request is outstanding" would let one hung
// glyph host pin the loop for the session — the never-idle wedge #2091 was, one resource
// class over. Test 3 severs exactly that: a fetch that NEVER settles.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import { TextStage } from './text-stage'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import { createRasterizer, createMetricsRasterizer } from './sdf/glyph-rasterizer'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'
import { XGISMap } from '../map'

const GLYPHS_URL = 'https://tiles.example.com/fonts/{fontstack}/{range}.pbf'

// The REAL committed range, so the cache's SUCCESS arm (`.then` → `{status:'loaded'}`)
// actually executes. Every other test here settles through a body that decodes to nothing,
// which reaches `'failed'` — a terminal state, but the WRONG one to prove the release on:
// moving the stamp cleanup out of `.finally` into `.catch` would leave the landed path
// leaking and every failure-path test would still pass.
const PBF_BYTES = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    'sdf',
    'pbf',
    '__fixtures__',
    'open-sans-semibold-0-255.pbf',
  ),
)

/** Read the cache's private in-flight set. White-box on purpose: "the expired key was
 *  PRUNED" and "the expired key is still there but reports false" are indistinguishable
 *  from the outside, and the one that leaks is the one that matters. */
const inflightSize = (c: GlyphPbfCache): number =>
  (c as unknown as { loadingSince: Map<string, number> }).loadingSince.size

/** A fetch whose response we resolve by hand, so "in flight" is a state the test owns. */
function deferredFetch(body?: Uint8Array): {
  fetch: typeof globalThis.fetch
  settle: () => void
  reject: () => void
  calls: () => number
} {
  let release: (() => void) | null = null
  let fail: (() => void) | null = null
  let calls = 0
  const fetch = ((): Promise<Response> => {
    calls++
    return new Promise<Response>((res, rej) => {
      release = () =>
        res(
          new Response(body ?? new Uint8Array(0), {
            status: 200,
            headers: { 'content-type': 'application/x-protobuf' },
          }),
        )
      fail = () => rej(new Error('network down'))
    })
  }) as unknown as typeof globalThis.fetch
  return {
    fetch,
    settle: () => release?.(),
    reject: () => fail?.(),
    calls: () => calls,
  }
}

/** Drain the microtask queue so the cache's `.then/.catch/.finally` chain has run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => vi.restoreAllMocks())

describe('GlyphPbfCache.hasPendingLoads', () => {
  it('is false before anything is requested, true while a range is in flight, false once it lands', async () => {
    const net = deferredFetch()
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })
    expect(cache.hasPendingLoads()).toBe(false)

    cache.ensure('Open Sans Semibold', 65, () => {})
    expect(net.calls()).toBe(1)
    // THE POINT: the range is outstanding, so the loop must stay awake.
    expect(cache.hasPendingLoads()).toBe(true)

    net.settle()
    await flush()
    // Terminal state reached (the empty body decodes to no fontstack → 'failed', which is
    // still terminal). Either way the loop is released.
    expect(cache.hasPendingLoads()).toBe(false)
  })

  it('releases the loop when the range FAILS, not just when it loads', async () => {
    const net = deferredFetch()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })
    cache.ensure('Open Sans Semibold', 65, () => {})
    expect(cache.hasPendingLoads()).toBe(true)
    net.reject()
    await flush()
    expect(cache.hasPendingLoads()).toBe(false)
  })

  // The anti-#2091 assertion. `safeFetch` carries no timeout; without the deadline this
  // test hangs the render loop forever and the map never idles again.
  it('stops holding the loop past the deadline even if the fetch NEVER settles', () => {
    const net = deferredFetch()
    let clock = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })

    cache.ensure('Open Sans Semibold', 65, () => {})
    expect(cache.hasPendingLoads()).toBe(true)

    clock += 9_000 // still inside the 10 s keep-warm deadline
    expect(cache.hasPendingLoads()).toBe(true)

    clock += 1_500 // past it — the request is STILL outstanding, and the loop is released
    expect(cache.hasPendingLoads()).toBe(false)
    // ...and stays released, without the in-flight set growing dead keys.
    expect(cache.hasPendingLoads()).toBe(false)
  })

  // The mutant this kills: move the `loadingSince` cleanup out of `.finally` and into the
  // `.catch` arm. Every OTHER test here settles through a body that decodes to nothing and
  // therefore lands in `.catch`, so they would all still pass while a successfully LANDED
  // range pinned the loop for its full deadline.
  it('releases the loop on the SUCCESS arm, with a real decodable range', async () => {
    const net = deferredFetch(PBF_BYTES)
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })
    cache.ensure('Open Sans Semibold', 65, () => {})
    expect(cache.hasPendingLoads()).toBe(true)
    net.settle()
    await flush()
    // Actually loaded, not merely terminal — the glyph is retrievable.
    expect(cache.get('Open Sans Semibold', 65)).toBeDefined()
    expect(cache.hasPendingLoads()).toBe(false)
    expect(inflightSize(cache)).toBe(0)
  })

  // The mutant this kills: `for (const [k, since] of this.loadingSince) return now - since <=
  // DEADLINE` — a verdict from the FIRST entry only. With one entry in flight it is
  // indistinguishable from the real sweep; with an expired entry ahead of a fresh one it
  // reports "nothing pending" while a range is genuinely still coming, which is #2116 again.
  it('sweeps EVERY in-flight range, not just the first — and prunes only the expired one', () => {
    const net = deferredFetch()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })

    cache.ensure('Open Sans Semibold', 65, () => {}) // range 0-255, stamped at t=0
    clock += 9_000
    cache.ensure('Open Sans Semibold', 400, () => {}) // range 256-511, stamped at t=9000
    expect(inflightSize(cache)).toBe(2)
    expect(net.calls()).toBe(2)

    clock += 2_000 // 0-255 is 11 s old (expired); 256-511 is 2 s old (fresh)
    expect(cache.hasPendingLoads()).toBe(true)
    // ...and the sweep dropped the expired one WITHOUT dropping the live one. A
    // non-pruning implementation returns the same `true` here; only the size tells them
    // apart, which is why this reads the private set.
    expect(inflightSize(cache)).toBe(1)
  })

  it('clears the stamp on the SSRF-refused path, which never issues a fetch at all', () => {
    const net = deferredFetch()
    const cache = new GlyphPbfCache({
      // Loopback is refused by assertSafeRemoteUrl before any request is made, and that
      // early return is its own cleanup site — not covered by `fireCallbacks`.
      glyphsUrl: 'http://127.0.0.1:9/fonts/{fontstack}/{range}.pbf',
      fetch: net.fetch,
    })
    cache.ensure('Open Sans Semibold', 65, () => {})
    expect(net.calls()).toBe(0)
    expect(cache.hasPendingLoads()).toBe(false)
    expect(inflightSize(cache)).toBe(0)
  })

  it('does not re-arm on a range it has already given up on', () => {
    const net = deferredFetch()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })
    cache.ensure('Open Sans Semibold', 65, () => {})
    clock += 20_000
    expect(cache.hasPendingLoads()).toBe(false)
    // A second ensure for the SAME range coalesces onto the still-'loading' state rather
    // than issuing a new request, so it must not restart the keep-warm clock.
    cache.ensure('Open Sans Semibold', 66, () => {})
    expect(net.calls()).toBe(1)
    expect(cache.hasPendingLoads()).toBe(false)
  })
})

describe('PbfRasterizer.hasPendingLoads', () => {
  const build = (providers: GlyphProvider[]): PbfRasterizer => {
    const full = createRasterizer()
    return new PbfRasterizer({
      fallback: createMetricsRasterizer(full),
      providers,
      cjkFull: full,
      fullFallback: full,
      onLanded: () => {},
    })
  }

  it('ORs the chain, and a provider that cannot load never holds the loop', () => {
    const inert: GlyphProvider = { get: () => undefined }
    const busy: GlyphProvider = { get: () => undefined, hasPendingLoads: () => true }
    expect(build([inert]).hasPendingLoads()).toBe(false)
    // BOTH orders. With `busy` only ever last, `return providers.at(-1)?.hasPendingLoads()`
    // passes — the chain is cheapest-source-first, so the remote cache that actually loads
    // is normally last and the mutant would be invisible in production too.
    expect(build([inert, busy]).hasPendingLoads()).toBe(true)
    expect(build([busy, inert]).hasPendingLoads()).toBe(true)
  })

  it('goes false again when every provider in the chain has settled', () => {
    let busy = true
    const p: GlyphProvider = { get: () => undefined, hasPendingLoads: () => busy }
    const ras = build([p])
    expect(ras.hasPendingLoads()).toBe(true)
    busy = false
    expect(ras.hasPendingLoads()).toBe(false)
  })
})

describe('TextStage.hasPendingGlyphLoads — the real body, not a stub', () => {
  // The map-level test below injects a fake `textStage`, so it proves the map ASKS but can
  // never see what the real stage ANSWERS. That gap is not hypothetical: it is exactly how
  // this fix was first reasoned about against a scene whose stage has `pbfRasterizer ===
  // null` (see #2121 — the `import "<style.json>"` path drops the style's `glyphs` URL, so
  // no PBF chain is built and this method's `?? false` arm is the only one that runs).
  // Called through the prototype so no GPU device is needed to execute the real statement.
  const realBody = (
    TextStage.prototype as unknown as { hasPendingGlyphLoads: (this: unknown) => boolean }
  ).hasPendingGlyphLoads
  const ask = (stage: unknown): boolean => realBody.call(stage)

  it('delegates to the PBF rasterizer when there is one', () => {
    expect(ask({ pbfRasterizer: { hasPendingLoads: () => true } })).toBe(true)
    expect(ask({ pbfRasterizer: { hasPendingLoads: () => false } })).toBe(false)
  })

  it('answers false — NOT true — when the stage has no PBF chain at all', () => {
    // A stage with no remote glyph source has nothing outstanding, so it must not hold the
    // loop. This is the arm that makes the predicate inert on a style-import scene; it is
    // correct behaviour for THIS method and a bug one layer up (#2121), and pinning it here
    // is what keeps the two from being confused again.
    expect(ask({ pbfRasterizer: null })).toBe(false)
  })
})

describe('XGISMap.shouldRenderThisFrame — the glyph keep-alive is WIRED', () => {
  // The predicate is worthless if the map never asks. This drives the real method with a
  // camera signature that is already settled, so the ONLY thing that can keep the frame
  // alive is the glyph probe — flipping it must flip the verdict.
  const settledMap = (pendingGlyphs: () => boolean): XGISMap => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const h = map as unknown as Record<string, unknown>
    h._needsRender = false
    h._sceneHasAnimation = false
    h.textStage = {
      getFadeLedger: () => ({ hasActive: () => false }),
      hasPendingGlyphLoads: pendingGlyphs,
    }
    const c = (map as unknown as { camera: Record<string, number> }).camera
    h._lastSigZoom = c.zoom
    h._lastSigCX = c.centerX
    h._lastSigCY = c.centerY
    h._lastSigBearing = c.bearing
    h._lastSigPitch = c.pitch
    h._lastSigW = 0
    h._lastSigH = 0
    return map
  }
  const ask = (map: XGISMap): boolean =>
    (map as unknown as { shouldRenderThisFrame: () => boolean }).shouldRenderThisFrame()

  it('renders a settled frame ONLY when a glyph range is outstanding', () => {
    expect(ask(settledMap(() => false))).toBe(false)
    expect(ask(settledMap(() => true))).toBe(true)
  })
})

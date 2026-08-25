// ═══ #2122 — `idle` must not mean "converged except for images" either ═══
//
// #2116 closed this for glyphs. The sprite atlas is the same hole: `IconStage` is
// constructed lazily on the first frame that needs it, its `SpriteAtlasHost` kicks off two
// fetches, and NOTHING sets `_needsRender` — so the very next frame every term of
// `shouldRenderThisFrame` reads false, `idle` fires, and a settle-on-idle sampler reads a
// frame with no icons and an unresolved fill-pattern. `fixture-bg-pattern.xgis` hits this
// with no labels and no VT source at all, and `background-pattern-atlas.ts:15-19` already
// records the symptom in the past tense: "the async atlas landed on a frozen canvas".
//
// The load-bearing half is BOUNDEDNESS, and the obvious predicate gets it wrong.
// `isAtlasTerminal()` looks like the answer — it is already on IconStage and already means
// "no further icon resolution can arrive" — but it is the prepare-SKIP question, and
// `safeFetch` carries no timeout, so against a host that accepts a connection and never
// answers it stays false for the session. Keeping the loop warm on it is #2091's never-idle
// wedge, one resource class over. The keep-alive therefore reads a SEPARATE, deadlined
// predicate; the third block below is the test that distinguishes the two.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { SpriteAtlasHost, SPRITE_INFLIGHT_KEEP_WARM_MS } from './sprite-atlas-host'
import { IconStage } from './icon-stage'
import { XGISMap } from '../map'

const SPRITE_URL = 'https://tiles.example.com/sprite'
const hang = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch
const reject = (() =>
  Promise.reject(new Error('network down'))) as unknown as typeof globalThis.fetch

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
/** Drains the whole safeFetch await chain — deeper than `flush`, plus one macrotask turn, so a
 *  multi-await fallback path has actually been ENTERED before the assertion looks at it. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The REAL prototype bodies against a hand-built `{ host }` — no re-implementation, and no
 *  GPUDevice needed to reach them. */
const proto = IconStage.prototype as unknown as {
  isAtlasTerminal: (this: unknown) => boolean
  hasPendingAtlasLoad: (this: unknown) => boolean
}
const terminal = (host: unknown): boolean => proto.isAtlasTerminal.call({ host })
const pending = (host: unknown): boolean => proto.hasPendingAtlasLoad.call({ host })

afterEach(() => vi.restoreAllMocks())

describe('SpriteAtlasHost.hasPendingLoad — against a real host', () => {
  it('is true while the atlas fetch is outstanding', () => {
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: hang })
    expect(host.hasPendingLoad()).toBe(true)
  })

  it('goes false once the load settles as failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: reject })
    expect(host.hasPendingLoad()).toBe(true)
    await flush()
    expect(host.hasPendingLoad()).toBe(false)
  })

  // The SSRF guard refuses before issuing a fetch and degrades straight to 'failed'
  // (`sprite-atlas-host.ts` kickOffLoad). Nothing is outstanding, so nothing is kept warm —
  // a hostile style must not be able to hold the render loop open either.
  it('is false for a URL the SSRF guard refuses (no fetch issued)', () => {
    const host = new SpriteAtlasHost({
      spriteUrl: 'http://127.0.0.1/sprite',
      fetch: hang,
    })
    expect(host.getState().status).toBe('failed')
    expect(host.hasPendingLoad()).toBe(false)
  })

  it('stops keeping the loop warm after the deadline, and never re-arms', () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: hang })
    expect(host.hasPendingLoad()).toBe(true)
    now = 1_000 + SPRITE_INFLIGHT_KEEP_WARM_MS
    expect(host.hasPendingLoad()).toBe(true) // inclusive at the boundary
    now = 1_000 + SPRITE_INFLIGHT_KEEP_WARM_MS + 1
    expect(host.hasPendingLoad()).toBe(false)
    now = 1_000 + SPRITE_INFLIGHT_KEEP_WARM_MS * 10
    expect(host.hasPendingLoad()).toBe(false)
  })
})

describe('SpriteAtlasHost.hasPendingLoad — the SUCCESS arm and the @2x fallback', () => {
  // Every other arm here ends in 'failed'. Without this block the exact mutant
  // `hasPendingLoad() { return this.state.status !== 'loaded' }` — the one the glyph twin
  // documents as its killer — survives all of them: on a failing host it is
  // indistinguishable from the real predicate. vitest ships no image decoder, so the PNG
  // decode is stubbed exactly as sprite-atlas-host.test.ts:33-46 does.
  const FIXTURE_JSON = { pin: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 } }
  const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const stubDecode = (): (() => void) => {
    const g = globalThis as { createImageBitmap?: unknown }
    const original = g.createImageBitmap
    g.createImageBitmap = async () => ({ width: 256, height: 256, close: () => {} }) as ImageBitmap
    return () => {
      g.createImageBitmap = original
    }
  }

  const okFetch = (opts: { deny2x?: boolean } = {}): typeof globalThis.fetch =>
    ((input: RequestInfo | URL) => {
      const url = String(input)
      if (opts.deny2x === true && url.includes('@2x'))
        return Promise.resolve(new Response('', { status: 404 }))
      return Promise.resolve(
        url.endsWith('.json')
          ? new Response(JSON.stringify(FIXTURE_JSON), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      )
    }) as typeof globalThis.fetch

  it('goes false once the load SUCCEEDS, not only when it fails', async () => {
    const restore = stubDecode()
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: okFetch() })
    expect(host.hasPendingLoad()).toBe(true)
    await host.whenReady()
    restore()
    expect(host.getState().status).toBe('loaded')
    expect(host.hasPendingLoad()).toBe(false)
  })

  // The dpr>=1.5 path issues TWO sequential attempts (@2x, then 1x on a miss). The deadline is
  // stamped ONCE, in kickOffLoad, so the whole chain shares one budget — the bounded quantity is
  // "how long may an unresolved atlas hold the render loop", not "how long per HTTP request".
  //
  // The clock is advanced SYNCHRONOUSLY after construction, before any microtask runs, so the
  // fallback attempt is entered on the far side of the deadline. That is what makes this test
  // distinguish the two designs: with the real once-at-kickOff stamp the predicate is already
  // false when the 1x attempt starts, while a per-attempt re-stamp would reset it to 0 elapsed
  // and read as pending — silently doubling the real bound. Verified to kill exactly that mutant.
  it('spans the @2x → 1x fallback on ONE deadline, stamped at kickOff', async () => {
    let now = 500
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const restore = stubDecode()
    // @2x misses; the 1x attempt then hangs, so the host stays in 'loading' to be observed.
    const fetchFn = ((input: RequestInfo | URL) =>
      String(input).includes('@2x')
        ? Promise.resolve(new Response('', { status: 404 }))
        : new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch

    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: fetchFn, dpr: 2 })
    expect(host.hasPendingLoad()).toBe(true)
    now = 500 + SPRITE_INFLIGHT_KEEP_WARM_MS + 1
    await settle()
    restore()

    expect(host.getState().status, 'the 1x fallback must be in flight to observe').toBe('loading')
    expect(host.hasPendingLoad()).toBe(false)
  })
})

describe('IconStage.hasPendingAtlasLoad — the chain', () => {
  it('delegates to the host', () => {
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: hang })
    expect(pending(host)).toBe(true)
  })

  // #797's injected host DRAWING API atlas has no fetch at all and does not implement the
  // optional member. It must read as "nothing pending", never as "unknown, stay warm".
  it('reads false for an injected host atlas that does not implement it', () => {
    expect(pending({ getState: () => ({ status: 'loaded' as const }) })).toBe(false)
  })
})

describe('the two predicates answer DIFFERENT questions', () => {
  // This is the whole reason `hasPendingLoad` exists rather than reusing `isAtlasTerminal`.
  // A host that accepts a connection and never answers is never terminal — so a keep-alive
  // built on `isAtlasTerminal` would hold the loop for the session. The deadlined predicate
  // releases it. If these two ever agree here, the keep-alive is unbounded again.
  it('a never-answering host is never terminal, yet stops being pending at the deadline', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const host = new SpriteAtlasHost({ spriteUrl: SPRITE_URL, fetch: hang })
    expect(terminal(host)).toBe(false)
    expect(pending(host)).toBe(true)
    now = SPRITE_INFLIGHT_KEEP_WARM_MS * 100
    expect(terminal(host)).toBe(false) // still false — unbounded, as documented
    expect(pending(host)).toBe(false) // bounded — the loop is released
  })
})

describe('XGISMap.shouldRenderThisFrame — the sprite keep-alive is WIRED', () => {
  // Same construction as the glyph wiring test: an already-settled camera signature, so the
  // ONLY thing that can keep the frame alive is the sprite probe.
  const settledMap = (hasPendingAtlasLoad: () => boolean): XGISMap => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const h = map as unknown as Record<string, unknown>
    h._needsRender = false
    h._sceneHasAnimation = false
    h.textStage = null
    h.iconStage = { hasPendingAtlasLoad }
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

  it('renders a settled frame while the atlas load is pending, and stops once it is not', () => {
    expect(ask(settledMap(() => true))).toBe(true)
    expect(ask(settledMap(() => false))).toBe(false)
  })

  it('a map with no icon stage at all is unaffected', () => {
    const map = settledMap(() => true)
    ;(map as unknown as Record<string, unknown>).iconStage = null
    expect(ask(map)).toBe(false)
  })
})

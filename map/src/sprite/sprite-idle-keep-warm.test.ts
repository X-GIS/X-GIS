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

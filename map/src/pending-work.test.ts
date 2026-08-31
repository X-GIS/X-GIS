// ═══ #2149 — the pending-work contract suite: five arms per registered kind ═══
//
// ONE factory iterates PENDING_WORK_KINDS — the same runtime constant the registry is
// built from, so there is no second hand-synced list (CLAUDE.md §12, the second-ratchet
// trap). Every kind must supply a fixture, keyed by the SAME union
// (`Record<PendingWorkKind, KindFixture>`), proving the arms #2129 codified:
//
//   in-flight → warm; SUCCESS → cold; failure → cold; past-deadline → cold and it STAYS
//   cold (no re-arm). The success arm is load-bearing: every arm ending in 'failed' lets
//   the mutant `return status !== 'failed'` survive — that gap was real in #2122.
//
// Each fixture drives the kind's REAL production chain (no stubs of the thing under
// test): for 'glyph' that is GlyphPbfCache → PbfRasterizer → the real
// TextStage.hasPendingGlyphLoads body → buildPendingWorkRegistry's probe. The deeper
// per-layer pins (deadline boundary values, in-flight-set pruning, provider-chain OR)
// stay in glyph-inflight-keep-warm.test.ts; this suite owns the seam.
//
// The map-side wire is pinned by the existing wiring test
// (glyph-inflight-keep-warm.test.ts, "the glyph keep-alive is WIRED"), which now
// exercises the registry route: severing the `_pendingWork.hasPending()` term in
// `shouldRenderThisFrame` reds that test; severing a registration or a fixture reds the
// compile (`Record<PendingWorkKind, …>`).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PENDING_WORK_KINDS,
  SCOPE_RASTER_DEM,
  SCOPE_VT_PIPELINE,
  buildPendingWorkRegistry,
  type PendingWorkKind,
  type PendingWorkRegistry,
  type TileLoadArm,
  type VtPendingArm,
} from './pending-work'
import { FailedTileLedger, InflightLedger, MAX_TILE_ATTEMPTS } from './render/tile-retry'
import { GlyphPbfCache } from './text/sdf/pbf/glyph-pbf-cache'
import { PbfRasterizer } from './text/sdf/pbf-rasterizer'
import { createRasterizer, createMetricsRasterizer } from './text/sdf/glyph-rasterizer'
import { TextStage } from './text/text-stage'
import { syncCoverageResidency, type CoverageSourceDeps } from './coverage-source'
import { SpriteAtlasHost } from './sprite/sprite-atlas-host'
import { IconStage } from './sprite/icon-stage'
import { XGISMap } from './map'

const GLYPHS_URL = 'https://tiles.example.com/fonts/{fontstack}/{range}.pbf'

// The real committed range, so the SUCCESS arm executes the cache's `.then` →
// `{status:'loaded'}` path (same fixture glyph-inflight-keep-warm.test.ts uses, for the
// same reason: an empty body decodes to nothing and lands in `.catch`).
const PBF_BYTES = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    'text',
    'sdf',
    'pbf',
    '__fixtures__',
    'open-sans-semibold-0-255.pbf',
  ),
)

/** A fetch the test resolves by hand, so "in flight" is a state the test owns. */
function deferredFetch(body: Uint8Array): {
  fetch: typeof globalThis.fetch
  settle: () => void
  reject: () => void
} {
  let release: (() => void) | null = null
  let fail: (() => void) | null = null
  const fetch = ((): Promise<Response> =>
    new Promise<Response>((res, rej) => {
      release = () =>
        res(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-protobuf' },
          }),
        )
      fail = () => rej(new Error('network down'))
    })) as unknown as typeof globalThis.fetch
  return { fetch, settle: () => release?.(), reject: () => fail?.() }
}

/** Drain the microtask queue so the ledger's `.then/.catch/.finally` chain has run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** One kind's harness: a registry whose kind-under-test has exactly one request in
 *  flight, plus the levers that drive it to each terminal state. */
interface KindHarness {
  registry: PendingWorkRegistry
  /** Resolve the in-flight request successfully. */
  succeed(): Promise<void>
  /** Fail the in-flight request. */
  fail(): Promise<void>
  /** Advance the kind's clock comfortably past its keep-warm deadline. */
  expire(): void
}

interface KindFixture {
  inFlight(): KindHarness
}

// The real TextStage probe body, called through the prototype so no GPU device is needed
// (the recipe glyph-inflight-keep-warm.test.ts:252-255 established).
const realStageProbe = (
  TextStage.prototype as unknown as { hasPendingGlyphLoads: (this: unknown) => boolean }
).hasPendingGlyphLoads

// The real IconStage probe body, same prototype recipe (sprite-idle-keep-warm.test.ts).
const realIconProbe = (
  IconStage.prototype as unknown as { hasPendingAtlasLoad: (this: unknown) => boolean }
).hasPendingAtlasLoad
// Sprite fixture payloads, mirroring sprite-idle-keep-warm.test.ts (vitest ships no image
// decoder, so the PNG decode is stubbed during the success arm).
const SPRITE_JSON = { pin: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 } }
const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Drained raster/DEM arms for hosts whose kind-under-test is elsewhere. */
const coldArm = (): TileLoadArm => ({
  pendingLoadCount: () => 0,
  failedTiles: { hasPendingRetries: () => false },
})
const coldArms = () => ({
  rasterRenderer: coldArm(),
  hillshadeRenderer: coldArm(),
  vtSources: new Map<string, VtPendingArm>(),
})

/** A drained VT renderer arm for fixtures whose kind-under-test is one of its siblings. */
const quietVtRenderer = (): VtPendingArm['renderer'] => ({
  hasPendingUploads: () => false,
  getDrawStats: () => ({ missedTiles: 0 }),
  _selection: { _czPendingAdvance: null },
})

/** Keyed by the SAME union as the registry — a kind added without a fixture is a compile
 *  error here before it is a green test anywhere. */
const FIXTURES: Record<PendingWorkKind, KindFixture> = {
  glyph: {
    inFlight() {
      let clock = 1_000
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const net = deferredFetch(PBF_BYTES)
      const cache = new GlyphPbfCache({ glyphsUrl: GLYPHS_URL, fetch: net.fetch })
      const full = createRasterizer()
      const rasterizer = new PbfRasterizer({
        fallback: createMetricsRasterizer(full),
        providers: [cache],
        cjkFull: full,
        fullFallback: full,
        onLanded: () => {},
      })
      const registry = buildPendingWorkRegistry({
        textStage: {
          hasPendingGlyphLoads: () => realStageProbe.call({ pbfRasterizer: rasterizer }),
        },
        iconStage: null,
        ...coldArms(),
      })
      cache.ensure('Open Sans Semibold', 65, () => {})
      return {
        registry,
        succeed: async () => {
          net.settle()
          await flush()
        },
        fail: async () => {
          net.reject()
          await flush()
        },
        // The deadline constant is ledger-internal (glyph-pbf-cache.ts:40, 10 s); 20 s is
        // comfortably past it, mirroring the existing suite's no-re-arm test.
        expire: () => {
          clock += 20_000
        },
      }
    },
  },
  // #2122 — probe flavor over the real chain: SpriteAtlasHost (real; it issues its
  // fetches at construction, so the harness queues the resolvers and answers by URL
  // shape) → the real IconStage.hasPendingAtlasLoad body → the registration's probe.
  sprite: {
    inFlight() {
      let clock = 1_000
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const pending: Array<{ url: string; res: (r: Response) => void; rej: (e: Error) => void }> =
        []
      const fetchFn = ((input: RequestInfo | URL) =>
        new Promise<Response>((res, rej) => {
          pending.push({ url: String(input), res, rej })
        })) as unknown as typeof globalThis.fetch
      const host = new SpriteAtlasHost({
        spriteUrl: 'https://tiles.example.com/sprite',
        fetch: fetchFn,
      })
      const registry = buildPendingWorkRegistry({
        textStage: null,
        iconStage: { hasPendingAtlasLoad: () => realIconProbe.call({ host }) },
        ...coldArms(),
      })
      return {
        registry,
        succeed: async () => {
          const g = globalThis as { createImageBitmap?: unknown }
          const original = g.createImageBitmap
          g.createImageBitmap = async () =>
            ({ width: 256, height: 256, close: () => {} }) as ImageBitmap
          for (let i = 0; i < 8; i++) {
            while (pending.length) {
              const p = pending.shift()!
              p.res(
                p.url.endsWith('.json')
                  ? new Response(JSON.stringify(SPRITE_JSON), {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                    })
                  : new Response(TINY_PNG, {
                      status: 200,
                      headers: { 'content-type': 'image/png' },
                    }),
              )
            }
            await flush()
          }
          g.createImageBitmap = original
          // Actually loaded, not merely terminal — the success arm must be the real one.
          expect(host.getState().status).toBe('loaded')
        },
        fail: async () => {
          pending.shift()?.rej(new Error('network down'))
          await flush()
        },
        expire: () => {
          clock += 20_000
        },
      }
    },
  },
  // #2129 — ledger flavor: the registry owns the stamps and the deadline
  // (COVERAGE_INFLIGHT_KEEP_WARM_MS, pending-work.ts), so this fixture drives the real
  // ledger through the real `begin()`. Success and failure both settle through the ONE
  // `finally` in readCatalogueItem (coverage-source.ts — `ticket?.done()` beside
  // `state.inFlight.delete`), so at this seam the two arms are the same lever BY
  // CONSTRUCTION; the wiring block below executes that finally through the real
  // production function on the failure route, and the hang route proves begin-before-await.
  coverage: {
    inFlight() {
      let clock = 1_000
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const registry = buildPendingWorkRegistry({ textStage: null, iconStage: null, ...coldArms() })
      const ticket = registry.begin('coverage')
      return {
        registry,
        succeed: async () => ticket.done(),
        fail: async () => ticket.done(),
        expire: () => {
          clock += 20_000
        },
      }
    },
  },
  // #2149 increment 4 — the raster/DEM arms, against the REAL shared ledgers
  // (tile-retry.ts). The fetch kinds drive a real InflightLedger: warm while a key is
  // checked out, released when the settle handler deletes it (success and failure share
  // that one line in both renderers' `.then` chains), and deadline-bounded by
  // RASTER_INFLIGHT_KEEP_WARM_MS — the arm a hung host used to hold open forever.
  'raster-fetch': { inFlight: () => inflightHarness('rasterRenderer') },
  'dem-fetch': { inFlight: () => inflightHarness('hillshadeRenderer') },
  // The retry kinds drive a real FailedTileLedger. Their bound is ATTEMPT-count, not a
  // wall stamp: hasPendingRetries stays true across the backoff (that is its purpose —
  // more failures keep it warm) and goes false at MAX_TILE_ATTEMPTS, ~10.5 s of schedule.
  // So for these kinds succeed() := the tile finally loads (clear), and both fail() and
  // expire() := the budget exhausts — the ledger's own terminal state.
  'raster-retry': { inFlight: () => retryHarness('rasterRenderer') },
  'dem-retry': { inFlight: () => retryHarness('hillshadeRenderer') },
  // #2149 increment 5 — the VT family. These fixtures drive the REGISTRATIONS through
  // structural source arms, not the real TileCatalog/VectorTileRenderer: both are
  // GPU/worker-bound, and their BOUNDS already have real-chain owners this suite
  // deliberately delegates to (named in VtPendingArm's doc): vt-fetch/vt-missed →
  // tile-decision's #1596 terminal rule (render-loop-keep-warm.test.ts drives the real
  // classifyTile); vt-lod → the readiness gate's reach-or-timeout contract
  // (readiness-gate-unreachable-target.test.ts drives the real TileSelectionCache);
  // vt-replaced → the #1448 swap application; vt-upload → the per-frame drain. What THIS
  // suite owns for these kinds is the transport: probe → registration → registry →
  // scopes → the map wire, plus the cuts that distinguish each half. succeed/fail/expire
  // all settle the flag — the underlying settle semantics are the delegated owners'.
  'vt-fetch': vtFixture((warm) => ({
    source: { hasPendingLoads: () => warm() },
    renderer: quietVtRenderer(),
  })),
  'vt-replaced': vtFixture((warm) => ({
    source: { hasReplacedKeys: () => warm() },
    renderer: quietVtRenderer(),
  })),
  'vt-upload': vtFixture((warm) => ({
    source: {},
    renderer: { ...quietVtRenderer(), hasPendingUploads: () => warm() },
  })),
  'vt-missed': vtFixture((warm) => ({
    source: {},
    renderer: { ...quietVtRenderer(), getDrawStats: () => ({ missedTiles: warm() ? 3 : 0 }) },
  })),
  'vt-lod': vtFixture((warm) => ({
    source: {},
    renderer: {
      ...quietVtRenderer(),
      // A getter, not a plain property: the arm is built once, so an eager object would
      // freeze the flag at construction — the exact one-shot-capture shape #1972 warns
      // about, here in miniature.
      get _selection() {
        return { _czPendingAdvance: warm() ? { target: 2, since: 0 } : null }
      },
    },
  })),
}

/** One VT kind's harness: a single attached source whose arm reads the shared flag. */
function vtFixture(arm: (warm: () => boolean) => VtPendingArm): KindFixture {
  return {
    inFlight() {
      let warm = true
      const registry = buildPendingWorkRegistry({
        textStage: null,
        iconStage: null,
        ...coldArms(),
        vtSources: new Map([['s', arm(() => warm)]]),
      })
      const settle = async (): Promise<void> => {
        warm = false
      }
      return {
        registry,
        succeed: settle,
        fail: settle,
        expire: () => {
          warm = false
        },
      }
    },
  }
}

/** Fetch-kind harness: one key checked out of a REAL InflightLedger, surfaced through
 *  the named renderer arm exactly as the renderers surface it (pendingLoadCount =
 *  liveCount). */
function inflightHarness(arm: 'rasterRenderer' | 'hillshadeRenderer'): KindHarness {
  // tile-retry's clock is nowMs() = Date.now() (deliberate, #1575) — spy THAT, not
  // performance.now, or the deadline arm silently measures the real wall clock.
  let clock = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const ledger = new InflightLedger()
  const host = {
    textStage: null,
    iconStage: null,
    ...coldArms(),
    [arm]: {
      pendingLoadCount: () => ledger.liveCount(),
      failedTiles: { hasPendingRetries: () => false },
    },
  }
  const registry = buildPendingWorkRegistry(host)
  ledger.set('8/1/2', new AbortController())
  const settle = async (): Promise<void> => {
    ledger.delete('8/1/2')
  }
  return {
    registry,
    succeed: settle,
    fail: settle,
    expire: () => {
      clock += 20_000
    },
  }
}

/** Retry-kind harness: one failed tile in a REAL FailedTileLedger, surfaced through the
 *  named renderer arm. */
function retryHarness(arm: 'rasterRenderer' | 'hillshadeRenderer'): KindHarness {
  // The retry bound is ATTEMPT-count; the pinned clock only keeps stamps deterministic.
  const clock = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const ledger = new FailedTileLedger()
  const host = {
    textStage: null,
    iconStage: null,
    ...coldArms(),
    [arm]: { pendingLoadCount: () => 0, failedTiles: ledger },
  }
  const registry = buildPendingWorkRegistry(host)
  ledger.noteOutcome('8/1/2', false)
  const exhaust = async (): Promise<void> => {
    for (let i = 1; i < MAX_TILE_ATTEMPTS; i++) ledger.noteOutcome('8/1/2', false)
  }
  return {
    registry,
    succeed: async () => ledger.clear('8/1/2'),
    fail: exhaust,
    expire: () => {
      void exhaust()
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('PendingWorkRegistry — a map with nothing registered in flight is cold', () => {
  it('reports no pending work when every probe reads a drained/absent stage', () => {
    expect(
      buildPendingWorkRegistry({ textStage: null, iconStage: null, ...coldArms() }).hasPending(),
    ).toBe(false)
  })
})

for (const kind of PENDING_WORK_KINDS) {
  const fixture = FIXTURES[kind]
  describe(`pending-work kind '${kind}' — the five contract arms, through the real chain`, () => {
    it('in-flight → warm', () => {
      expect(fixture.inFlight().registry.hasPending()).toBe(true)
    })

    it('SUCCESS → cold (not only failure — the #2122 mutant-killer)', async () => {
      const h = fixture.inFlight()
      await h.succeed()
      expect(h.registry.hasPending()).toBe(false)
    })

    it('failure → cold', async () => {
      const h = fixture.inFlight()
      await h.fail()
      expect(h.registry.hasPending()).toBe(false)
    })

    it('past-deadline → cold, and STAYS cold (no re-arm) — the anti-#2091 arm', () => {
      const h = fixture.inFlight()
      h.expire()
      expect(h.registry.hasPending()).toBe(false)
      expect(h.registry.hasPending()).toBe(false)
    })
  })
}

// ── #2129 — the coverage ticket is WIRED through the real cell-read path ──
// Drives the REAL exported entry (`syncCoverageResidency` → module-private
// `readCatalogueItem`) with a one-cell catalogue, so the two load-bearing lines are
// executed, not read: the ticket checkout on the line after the synchronous
// `state.inFlight.add` (warm before the first await — the exact #2129 requirement), and
// its `done()` in the settle `finally` (a failed read releases the loop).
describe('coverage — the ticket spans the real catalogue cell read (#2129)', () => {
  const item = { id: 'cell-a', bbox: [-10, -10, 10, 10], href: 'https://tiles.example.com/a.h5' }
  const buildDeps = (
    fetchFn: typeof globalThis.fetch,
    registry: PendingWorkRegistry,
  ): CoverageSourceDeps =>
    ({
      rawDatasets: new Map(),
      catalogues: new Map([
        [
          's',
          {
            url: 'https://tiles.example.com/cat.json',
            items: [item],
            wanted: [],
            suppressed: new Set(),
            inFlight: new Set(),
          },
        ],
      ]),
      view: () => [-180, -85, 180, 85],
      time: { nextEpoch: () => 1, isCurrent: () => true },
      guardedFetch: () => fetchFn,
      destroyed: () => false,
      invalidate: () => {},
      beginPendingWork: () => registry.begin('coverage'),
    }) as unknown as CoverageSourceDeps

  it('begins the ticket SYNCHRONOUSLY — warm before the first await', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = buildPendingWorkRegistry({ textStage: null, iconStage: null, ...coldArms() })
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch
    void syncCoverageResidency(buildDeps(hang, registry), 's')
    expect(registry.hasPending()).toBe(true)
  })

  it('dones the ticket in the settle finally — a FAILED read releases the loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = buildPendingWorkRegistry({ textStage: null, iconStage: null, ...coldArms() })
    const reject = (() =>
      Promise.reject(new Error('network down'))) as unknown as typeof globalThis.fetch
    await syncCoverageResidency(buildDeps(reject, registry), 's')
    expect(registry.hasPending()).toBe(false)
  })
})

// The map half: the `_coverageDeps.beginPendingWork` injection (map.ts) reaches the real
// registry, and a live ticket flips the real `shouldRenderThisFrame` on a settled frame.
// Severing the injection or the registry term reds exactly this block.
describe('XGISMap — a coverage ticket keeps the real shouldRenderThisFrame warm (#2129)', () => {
  it('the deps-record ticket flips the settled-frame verdict, and done() releases it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const h = map as unknown as Record<string, unknown>
    h._needsRender = false
    h._sceneHasAnimation = false
    h.textStage = null
    const c = (map as unknown as { camera: Record<string, number> }).camera
    h._lastSigZoom = c.zoom
    h._lastSigCX = c.centerX
    h._lastSigCY = c.centerY
    h._lastSigBearing = c.bearing
    h._lastSigPitch = c.pitch
    h._lastSigW = 0
    h._lastSigH = 0
    const ask = (): boolean =>
      (map as unknown as { shouldRenderThisFrame: () => boolean }).shouldRenderThisFrame()
    expect(ask()).toBe(false)
    const deps = (map as unknown as { _coverageDeps: { beginPendingWork: () => { done(): void } } })
      ._coverageDeps
    const ticket = deps.beginPendingWork()
    expect(ask()).toBe(true)
    ticket.done()
    expect(ask()).toBe(false)
  })
})

// ═══ #2149 increment 4 — the scope reads, and the raster wire into the real map ═══
describe('PendingWorkScope — SCOPE_RASTER_DEM discriminates', () => {
  it('sees raster work, and does NOT see glyph work', () => {
    const warmRaster = buildPendingWorkRegistry({
      textStage: null,
      iconStage: null,
      ...coldArms(),
      rasterRenderer: {
        pendingLoadCount: () => 1,
        failedTiles: { hasPendingRetries: () => false },
      },
    })
    expect(warmRaster.hasPending(SCOPE_RASTER_DEM)).toBe(true)
    const warmGlyph = buildPendingWorkRegistry({
      textStage: { hasPendingGlyphLoads: () => true },
      iconStage: null,
      ...coldArms(),
    })
    expect(warmGlyph.hasPending(SCOPE_RASTER_DEM)).toBe(false)
    expect(warmGlyph.hasPending()).toBe(true)
  })
})

describe('XGISMap — raster/DEM pending work keeps the real shouldRenderThisFrame warm', () => {
  it('a pre-boot map (renderers undefined) reads the kinds as drained, then a stubbed warm arm flips it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const h = map as unknown as Record<string, unknown>
    h._needsRender = false
    h._sceneHasAnimation = false
    h.textStage = null
    const c = (map as unknown as { camera: Record<string, number> }).camera
    h._lastSigZoom = c.zoom
    h._lastSigCX = c.centerX
    h._lastSigCY = c.centerY
    h._lastSigBearing = c.bearing
    h._lastSigPitch = c.pitch
    h._lastSigW = 0
    h._lastSigH = 0
    const ask = (): boolean =>
      (map as unknown as { shouldRenderThisFrame: () => boolean }).shouldRenderThisFrame()
    // Pre-boot: rasterRenderer/hillshadeRenderer are undefined — the optional-chained
    // probes must read 0, not throw (the settled control every arm below leans on).
    expect(ask()).toBe(false)
    h.rasterRenderer = {
      pendingLoadCount: () => 1,
      failedTiles: { hasPendingRetries: () => false },
      hasFadingTiles: () => false,
    }
    expect(ask()).toBe(true)
    ;(h.rasterRenderer as { pendingLoadCount: () => number }).pendingLoadCount = () => 0
    expect(ask()).toBe(false)
  })
})

describe('PendingWorkScope — SCOPE_VT_PIPELINE is exactly the burst-exit set', () => {
  const withVt = (arm: VtPendingArm) =>
    buildPendingWorkRegistry({
      textStage: null,
      iconStage: null,
      ...coldArms(),
      vtSources: new Map([['s', arm]]),
    })

  it('sees a pending VT fetch', () => {
    const r = withVt({ source: { hasPendingLoads: () => true }, renderer: quietVtRenderer() })
    expect(r.hasPending(SCOPE_VT_PIPELINE)).toBe(true)
  })

  it('does NOT see vt-lod — the burst never read it, and widening is #2150-gated', () => {
    const r = withVt({
      source: {},
      renderer: { ...quietVtRenderer(), _selection: { _czPendingAdvance: { target: 2 } } },
    })
    expect(r.hasPending(SCOPE_VT_PIPELINE)).toBe(false)
    expect(r.hasPending()).toBe(true)
  })

  it('does NOT see glyph work', () => {
    const r = buildPendingWorkRegistry({
      textStage: { hasPendingGlyphLoads: () => true },
      iconStage: null,
      ...coldArms(),
    })
    expect(r.hasPending(SCOPE_VT_PIPELINE)).toBe(false)
  })
})

describe('XGISMap — VT pending work keeps the real shouldRenderThisFrame warm (#2149 inc 5)', () => {
  // HONEST SCOPE: until increment 6 deletes the legacy `hasPendingSourceWork()` term,
  // shouldRenderThisFrame is DOUBLE-WIRED for the vt-* kinds — this test passes through
  // either route (verified: cutting the vt-fetch registration leaves it green via the
  // legacy term). It pins the map-level truth today and becomes the registry-only pin
  // the moment increment 6 lands; the registration-level cut coverage lives in the
  // contract arm + the SCOPE_VT_PIPELINE test, which the same cut DOES red.
  it('an attached source with a pending fetch flips the settled-frame verdict', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const h = map as unknown as Record<string, unknown>
    h._needsRender = false
    h._sceneHasAnimation = false
    h.textStage = null
    const c = (map as unknown as { camera: Record<string, number> }).camera
    h._lastSigZoom = c.zoom
    h._lastSigCX = c.centerX
    h._lastSigCY = c.centerY
    h._lastSigBearing = c.bearing
    h._lastSigPitch = c.pitch
    h._lastSigW = 0
    h._lastSigH = 0
    const ask = (): boolean =>
      (map as unknown as { shouldRenderThisFrame: () => boolean }).shouldRenderThisFrame()
    expect(ask()).toBe(false)
    let pending = true
    h.vtSources = new Map([
      [
        's',
        {
          source: { hasPendingLoads: () => pending },
          renderer: quietVtRenderer(),
        },
      ],
    ])
    expect(ask()).toBe(true)
    pending = false
    expect(ask()).toBe(false)
  })
})

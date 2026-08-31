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
  buildPendingWorkRegistry,
  type PendingWorkKind,
  type PendingWorkRegistry,
} from './pending-work'
import { GlyphPbfCache } from './text/sdf/pbf/glyph-pbf-cache'
import { PbfRasterizer } from './text/sdf/pbf-rasterizer'
import { createRasterizer, createMetricsRasterizer } from './text/sdf/glyph-rasterizer'
import { TextStage } from './text/text-stage'

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
}

afterEach(() => vi.restoreAllMocks())

describe('PendingWorkRegistry — a map with nothing registered in flight is cold', () => {
  it('reports no pending work when every probe reads a drained/absent stage', () => {
    expect(buildPendingWorkRegistry({ textStage: null }).hasPending()).toBe(false)
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

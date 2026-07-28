// ═══ Live refresh, RE-HOMED into the region machinery (#1158 × #1272 E-④) ═══
//
// `refreshCoverage` was written against the one-coverage model (a single `{_coverage, _url}`
// marker, a source-level epoch). The multi-region merge moved it into coverage-source.ts
// beside the push and step paths, and that move is not cosmetic — it changes two things this
// file gates:
//
//   1. THE EPOCH IS THE REGION'S, shared with push and step. On a separate counter a refresh
//      landing after a forecast step would silently revert the hour — the same failure the
//      step path's own counter exists to prevent, and the reason main's gate insists the swap
//      paths share one.
//   2. VALIDATORS ARE PER (source, REGION). A mosaic's regions are different URLs; one shared
//      validator would let a probe of one region decide for another, so a changed neighbour
//      would read as unchanged.
//
// The DECISION policy itself (validator comparison, the decision table, the poll loop) is
// gated in coverage-refresh.test.ts — this covers only the wiring that move created.

import { describe, it, expect, vi } from 'vitest'
import { refreshCoverageSource } from './coverage-source'
import { CoverageRefreshScheduler } from './coverage-refresh'
import { CoverageTimePlayer } from './coverage-time'
import { DEFAULT_REGION } from './render/coverage-renderer'
import type { CoverageSourceDeps } from './coverage-source'
import type { CoverageHandle } from '@xgis/data'

/** A handle stand-in — refresh never reads inside it, it only stores and arms it. */
const handleFor = (tag: string): CoverageHandle =>
  ({ meta: { sourceMeta: {}, size: [1, 1] }, __tag: tag }) as unknown as CoverageHandle

interface Harness {
  deps: CoverageSourceDeps
  armed: string[]
  refresh: CoverageRefreshScheduler
  /** Validators the fake server reports, per URL. */
  etags: Map<string, string>
  reads: string[]
}

function harness(regions: Array<[string, string | undefined]>): Harness {
  const armed: string[] = []
  const reads: string[] = []
  const etags = new Map<string, string>()
  const rawDatasets = new Map<string, never>()
  rawDatasets.set('bathy', {
    _coverage: new Map(regions.map(([r, url]) => [r, { handle: handleFor(`${r}:0`), url }])),
  } as never)
  const refresh = new CoverageRefreshScheduler()
  const deps = {
    rawDatasets,
    // A THUNK — `deps.renderer` is resolved at call time, because the map's real
    // `coverageRenderer` does not exist when the deps record is built (see
    // coverage-source.test.ts for the contract and the bug that forced it).
    renderer: () => ({
      displayOpts: () => ({ ramp: 'viridis', rangeLo: 0, rangeHi: 1, opacity: 1 }),
      setCoverage: (_h: unknown, _o: unknown, region: string) => void armed.push(region),
    }),
    time: new CoverageTimePlayer(),
    fieldArmed: () => false,
    armFields: () => {},
    // No `| arrow` / `| flow` layer in these fixtures: a refresh re-arms the FILL, which is
    // what `armed` above records (#1449).
    armFromShow: () => false,
    clearArrows: () => {},
    invalidate: () => {},
    refresh,
    // A fake origin: HEAD reports the URL's current etag; GET records the read.
    guardedFetch: () =>
      (async (u: unknown, init?: { method?: string }) => {
        const url = String(u)
        if (init?.method === 'HEAD')
          return { ok: true, headers: new Headers({ etag: etags.get(url) ?? '"v0"' }) } as Response
        reads.push(url)
        // Force the whole-file leg of the fetch ladder to fail fast; the range leg is what
        // coverage-fetch tries first and we stub its result through readCoverageRange below.
        throw new Error('no network in this gate')
      }) as unknown as typeof fetch,
    destroyed: () => false,
  } as unknown as CoverageSourceDeps
  return { deps, armed, refresh, etags, reads }
}

/** Lets one test hold the READ open, so it can supersede at a controlled moment. */
let holdRead: { entered: Promise<void>; release: () => void } | null = null

// The read itself is @xgis/data's job and is gated there; here it must simply succeed.
vi.mock('@xgis/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xgis/data')>()),
  readCoverageRange: vi.fn(async () => {
    if (holdRead) {
      const gate = holdRead
      holdRead = null
      gate.release() // signal "the epoch has been claimed, the read is in flight"
      await new Promise<void>((r) => setTimeout(r, 0))
    }
    return handleFor('fresh')
  }),
}))

describe('refreshCoverageSource — the re-homing (#1158 × #1272)', () => {
  it('skips the read when the validator is unchanged, and re-reads when it moves', async () => {
    const h = harness([[DEFAULT_REGION, 'https://x/cell.h5']])
    h.etags.set('https://x/cell.h5', '"v1"')
    // First probe has nothing stored → reads (every uncertain case reads).
    const first = await refreshCoverageSource(h.deps, 'bathy')
    expect(first).toEqual({ changed: true, reason: 'first-probe' })
    // Same etag → no read at all.
    const second = await refreshCoverageSource(h.deps, 'bathy')
    expect(second).toEqual({ changed: false, reason: 'unchanged' })
    // Moved etag → reads again.
    h.etags.set('https://x/cell.h5', '"v2"')
    const third = await refreshCoverageSource(h.deps, 'bathy')
    expect(third).toEqual({ changed: true, reason: 'validator-changed' })
  })

  it('keeps a validator PER REGION — a quiet mosaic re-reads NOTHING', async () => {
    // Order-INDEPENDENT fail-before for the composite key. An earlier version of this test
    // changed one region and asserted only it read; with a source-level key that passes or
    // fails depending on which concurrent region wrote the shared validator last, and it
    // happened to land on the passing side — a vacuous gate.
    //
    // This shape cannot: the two regions carry DIFFERENT etags, so a single shared validator
    // necessarily mismatches for at least one of them on the second pass, and a mosaic that
    // nothing changed under would re-read every frame of its poll.
    const h = harness([
      ['east', 'https://x/east.h5'],
      ['west', 'https://x/west.h5'],
    ])
    h.etags.set('https://x/east.h5', '"e1"')
    h.etags.set('https://x/west.h5', '"w1"')
    await refreshCoverageSource(h.deps, 'bathy') // both first-probe → both read
    expect(h.armed.sort()).toEqual(['east', 'west'])
    h.armed.length = 0
    // Nothing changed on the server. Neither region may re-read.
    const quiet = await refreshCoverageSource(h.deps, 'bathy')
    expect(quiet).toEqual({ changed: false, reason: 'unchanged' })
    expect(h.armed, 'an unchanged mosaic must arm nothing').toEqual([])
    // …and a change to ONE region still reaches it.
    h.etags.set('https://x/east.h5', '"e2"')
    const moved = await refreshCoverageSource(h.deps, 'bathy')
    expect(moved.changed).toBe(true)
    expect(h.armed).toEqual(['east'])
  })

  it('claims the REGION epoch, so a superseded re-read cannot arm', async () => {
    // The load-bearing property of the move. A refresh that started before a newer read of
    // the SAME region must not arm its stale handle — and because the counter is shared with
    // push/step, "newer read" includes a forecast step, not just another refresh.
    const h = harness([[DEFAULT_REGION, 'https://x/cell.h5']])
    // The epoch is claimed right before the READ (mirroring push/step, which claim right
    // before their own await) — NOT before the probe, or an "unchanged" refresh would burn a
    // counter and cancel a legitimate concurrent push that decided first. So supersede at the
    // one moment that proves the guard: after the claim, while the read is in flight.
    let release!: () => void
    const entered = new Promise<void>((r) => (release = r))
    holdRead = { entered, release }
    const inflight = refreshCoverageSource(h.deps, 'bathy')
    await entered
    h.deps.time.nextEpoch(DEFAULT_REGION) // a newer read of this region
    const result = await inflight
    expect(result.changed, 'a superseded refresh must report no change').toBe(false)
    expect(h.armed, 'and must not arm anything').toEqual([])
  })

  it('a urlless region is skipped without holding up its siblings', async () => {
    const h = harness([
      ['pushed', undefined],
      ['fetched', 'https://x/cell.h5'],
    ])
    const r = await refreshCoverageSource(h.deps, 'bathy')
    expect(r.changed).toBe(true)
    expect(h.armed).toEqual(['fetched'])
  })

  it('throws for a non-coverage source, and for one with no URL anywhere', async () => {
    const h = harness([['pushed', undefined]])
    await expect(refreshCoverageSource(h.deps, 'bathy')).rejects.toThrow(/host-pushed without/)
    await expect(refreshCoverageSource(h.deps, 'nope')).rejects.toThrow(/not a declared coverage/)
  })
})

// ═══ #1573 — a forecast step is all-or-nothing across the mosaic ═══
//
// `stepCoverageRegions` was a `Promise.all` of read-and-commit-each, and `Promise.all`
// neither cancels nor unwinds a sibling that already settled. A mosaic's regions are
// SEPARATE rolling URLs (NOAA re-issues per cell), so a 404 on a forecast re-issue hits one
// and not the others: the winners had already run `writeRegion` → `armRegion` at hour N+1
// while the loser stayed on hour N, and the map then drew two different valid times as one
// continuous current field. On a navigational chart that is worse than an error — it is a
// plausible-looking lie about the data — and under `playCoverageTime` the rejection was
// swallowed too, so the mixed state persisted with zero signal.
//
// The same file already isolates per region twice (`armCatalogueItem`, `loadDeclaredCoverage`,
// "One unreachable cell must not cost the mosaic its neighbours"), which is exactly why this
// site read as covered. Those two are LOAD paths, where a partial mosaic is the best
// available answer; a STEP has a coherent state to fall back to, so it takes the other
// branch: read every region, then commit every region.
//
// Harness mirrors coverage-source-refresh.test.ts, which gates the sibling path.

import { describe, it, expect, vi } from 'vitest'
import { stepCoverageRegions } from './coverage-source'
import { CoverageRefreshScheduler } from './coverage-refresh'
import { CoverageTimePlayer } from './coverage-time'
import type { CoverageSourceDeps } from './coverage-source'
import type { CoverageHandle } from '@xgis/data'

/** A handle stand-in carrying the forecast axis the step resolves against. `index` is the
 *  0-based hour it is currently showing. */
const handleAt = (tag: string, index: number): CoverageHandle =>
  ({
    meta: { sourceMeta: { time: { count: 5, index } }, size: [1, 1] },
    __tag: tag,
  }) as unknown as CoverageHandle

/** URLs whose read must reject — the rolling-URL blip, injected per region. */
const failing = new Set<string>()

vi.mock('@xgis/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xgis/data')>()),
  readCoverageRange: vi.fn(async (url: string, opts: { group: number }) => {
    if (failing.has(url)) throw new Error(`404 from the rolling origin: ${url}`)
    return handleAt(`${url}@${opts.group}`, opts.group - 1)
  }),
}))

function harness(regions: Array<[string, string]>) {
  const armed: string[] = []
  const rawDatasets = new Map<string, never>()
  rawDatasets.set('currents', {
    _coverage: new Map(regions.map(([r, url]) => [r, { handle: handleAt(`${r}@1`, 0), url }])),
  } as never)
  const deps = {
    rawDatasets,
    renderer: () => ({
      displayOpts: () => ({ ramp: 'viridis', rangeLo: 0, rangeHi: 1, opacity: 1 }),
      setCoverage: (_h: unknown, _o: unknown, region: string) => void armed.push(region),
    }),
    time: new CoverageTimePlayer(),
    fieldArmed: () => false,
    armFields: () => {},
    armFromShow: () => false,
    clearArrows: () => {},
    invalidate: () => {},
    refresh: new CoverageRefreshScheduler(),
    guardedFetch: () =>
      (async () => {
        throw new Error('no network in this gate')
      }) as unknown as typeof fetch,
    destroyed: () => false,
    runEpoch: () => 0,
  } as unknown as CoverageSourceDeps
  return { deps, armed, rawDatasets }
}

/** The hour each region's resident handle is showing, after whatever just happened. */
function hours(rawDatasets: Map<string, never>): Record<string, number> {
  const regions = (
    rawDatasets.get('currents') as unknown as { _coverage: Map<string, { handle: CoverageHandle }> }
  )._coverage
  const out: Record<string, number> = {}
  for (const [region, entry] of regions)
    out[region] = (entry.handle.meta.sourceMeta as { time: { index: number } }).time.index
  return out
}

describe('#1573 — one region failing must not land the mosaic on mixed hours', () => {
  it('commits NOTHING when a sibling read fails', async () => {
    failing.clear()
    failing.add('https://x/west.h5')
    const h = harness([
      ['east', 'https://x/east.h5'],
      ['west', 'https://x/west.h5'],
    ])
    expect(hours(h.rawDatasets), 'both start on hour 0').toEqual({ east: 0, west: 0 })

    await expect(stepCoverageRegions(h.deps, 'currents', 2)).rejects.toThrow(/404/)

    // Before the fix `east` was at hour 2 and armed, `west` still at hour 0 — the mosaic
    // drawing two valid times as one field, with the rejection carrying only west's error.
    expect(hours(h.rawDatasets), 'the mosaic stays coherent at the hour it was on').toEqual({
      east: 0,
      west: 0,
    })
    expect(h.armed, 'and nothing reached the renderer').toEqual([])
  })

  it('CONTROL — when every read succeeds, every region steps and arms', async () => {
    failing.clear()
    const h = harness([
      ['east', 'https://x/east.h5'],
      ['west', 'https://x/west.h5'],
    ])

    await stepCoverageRegions(h.deps, 'currents', 2)

    // Without this arm, a step that committed nothing ever would pass the case above.
    expect(hours(h.rawDatasets)).toEqual({ east: 2, west: 2 })
    expect(h.armed.sort()).toEqual(['east', 'west'])
  })

  it('CONTROL — a single-region source still steps (the mosaic case is not a special path)', async () => {
    failing.clear()
    const h = harness([['only', 'https://x/only.h5']])
    await stepCoverageRegions(h.deps, 'currents', 3)
    expect(hours(h.rawDatasets)).toEqual({ only: 3 })
    expect(h.armed).toEqual(['only'])
  })
})

// ═══ #2375 F-5 — forecast-step and playback reads must ride the abort spine ═══
//
// `map.ts`'s `guardedFetch` is where the coverage abort signal lives, and
// `_coverageAbort.cancelAll()` (the #1570 fix, run by BOTH destroy() and
// _teardownForReinit()) is what cancels it. Four coverage rungs pass that fetch
// down; two did not — `planOneRegion` (phase 1 of every setCoverageTime step)
// and `readRegionsAtGroup` (the per-transition read behind interpolated
// playback) called `readCoverageRange(url, { group })` with no `fetch`, so the
// reader fell through to the global one. Nothing held a signal, so nothing
// could stop them: the read streamed to completion across a destroy or a scene
// swap, on the two paths a user exercises most with a forecast coverage.
//
// The assertions are about CANCELLABILITY, not about a parameter being passed:
// each read is driven through a guarded fetch whose signal is already aborted,
// and the read must reject. A fix that threaded some unrelated function would
// satisfy an "opts.fetch is defined" check and still leave the read unstoppable.

import { describe, it, expect, vi } from 'vitest'
import { stepCoverageRegions, readRegionsAtGroup } from './coverage-source'
import { CoverageRefreshScheduler } from './coverage-refresh'
import { CoverageTimePlayer } from './coverage-time'
import type { CoverageSourceDeps } from './coverage-source'
import type { CoverageHandle } from '@xgis/data'

const handleAt = (tag: string, index: number): CoverageHandle =>
  ({
    meta: { sourceMeta: { time: { count: 5, index } }, size: [1, 1] },
    __tag: tag,
  }) as unknown as CoverageHandle

/** Every `fetch` the reader was handed, and the labels they were minted under. */
const seen: { fetches: unknown[]; labels: string[] } = { fetches: [], labels: [] }

// The reader stand-in USES the injected fetch rather than merely recording it —
// that is what makes an aborted signal reach the assertion instead of a
// parameter-shape check standing in for it.
vi.mock('@xgis/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xgis/data')>()),
  readCoverageRange: vi.fn(async (url: string, opts: { group: number; fetch?: typeof fetch }) => {
    seen.fetches.push(opts.fetch)
    if (opts.fetch) await opts.fetch(url)
    return handleAt(`${url}@${opts.group}`, opts.group - 1)
  }),
}))

/** A guarded fetch already carrying an ABORTED signal — the state
 *  `cancelAll()` leaves behind. Reads that ride it reject; reads that reach
 *  for the global `fetch` sail on, which is the defect. */
function abortedGuard(): CoverageSourceDeps['guardedFetch'] {
  const ac = new AbortController()
  ac.abort()
  return (label: string) => {
    seen.labels.push(label)
    return (async () => {
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Response()
    }) as unknown as typeof fetch
  }
}

function harness(regions: Array<[string, string]>) {
  const rawDatasets = new Map<string, never>()
  rawDatasets.set('currents', {
    _coverage: new Map(regions.map(([r, url]) => [r, { handle: handleAt(`${r}@1`, 0), url }])),
  } as never)
  return {
    rawDatasets,
    deps: {
      rawDatasets,
      renderer: () => ({
        displayOpts: () => ({ ramp: 'viridis', rangeLo: 0, rangeHi: 1, opacity: 1 }),
        setCoverage: () => {},
      }),
      time: new CoverageTimePlayer(),
      fieldArmed: () => false,
      armFields: () => {},
      armFromShow: () => false,
      clearArrows: () => {},
      invalidate: () => {},
      refresh: new CoverageRefreshScheduler(),
      guardedFetch: abortedGuard(),
      destroyed: () => false,
      runEpoch: () => 0,
    } as unknown as CoverageSourceDeps,
  }
}

const REGIONS: Array<[string, string]> = [['west', 'https://x/west.h5']]

describe('#2375 F-5 — the two bypassing rungs ride the coverage abort spine', () => {
  it('a forecast step is CANCELLED by an aborted coverage signal', async () => {
    seen.fetches = []
    seen.labels = []
    const h = harness(REGIONS)
    // Before the fix planOneRegion read through the global fetch, so the step
    // resolved happily against a map whose reads had already been cancelled.
    await expect(stepCoverageRegions(h.deps, 'currents', 2)).rejects.toThrow(/Abort/i)
    expect(seen.fetches[0], 'the reader was handed the guarded fetch').toBeDefined()
    expect(seen.labels.join(), 'and it was minted under a label naming the source').toContain(
      'currents',
    )
  })

  it('a playback transition read is CANCELLED by an aborted coverage signal', async () => {
    seen.fetches = []
    const h = harness(REGIONS)
    const regions = (h.rawDatasets.get('currents') as unknown as { _coverage: Map<string, never> })
      ._coverage
    await expect(
      readRegionsAtGroup(regions as never, 3, h.deps.guardedFetch('coverage playback')),
    ).rejects.toThrow(/Abort/i)
    expect(seen.fetches[0], 'the reader was handed the guarded fetch').toBeDefined()
  })

  it('CONTROL — with a LIVE guard both reads complete, so the gate is not just "everything throws"', async () => {
    seen.fetches = []
    const live = ((label: string) => {
      seen.labels.push(label)
      return (async () => new Response()) as unknown as typeof fetch
    }) as unknown as CoverageSourceDeps['guardedFetch']
    const h = harness(REGIONS)
    ;(h.deps as { guardedFetch: unknown }).guardedFetch = live
    await expect(stepCoverageRegions(h.deps, 'currents', 2)).resolves.toBeUndefined()
    expect(
      seen.fetches.every((f) => f !== undefined),
      'every read still rode a guard',
    ).toBe(true)
  })
})

// ═══ source-manager coverage dispatch (#1158, re-platformed by ADR-0010; deferred by #1426) ═══
//
// The built-in `type: coverage` branch REGISTERS the source and returns — the cell streams in
// the BACKGROUND (`beginCoverageLoad` → coverage-source's `loadDeclaredCoverage`, gated
// below in its own describe). Awaiting the read here put it in front of run()'s load barrier
// and therefore in front of the first frame, so the whole map stayed black for the entire
// multi-MB stream and an unreachable cell aborted the mount instead of degrading to the
// other layers (#1426).
//
// So this file pins the SPLIT: the attach writes an EMPTY region marker synchronously and
// hands the URL to the background loader; the loader does the fetch, the region write, the
// arm, and — crucially — contains its own failures.
//
// safeFetch is spied on the shared namespace so the named import resolves to the stub at call
// time (the source-manager-drop-tiling precedent). The fixture is the committed
// asym_southflip.h5 (2×3 S-102 cell: origin [5,50], spacing [2,1], datum 23, SW=10
// positive-down, SE=nodata) — the reader's own differential fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_REGION } from './render/coverage-renderer'
import type { CoverageRegionData } from './map-types'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as shared from '@xgis/shared'
import { SourceManager } from './source-manager'
import { loadDeclaredCoverage, type CoverageSourceDeps } from './coverage-source'
import type { CoverageHandle } from '@xgis/data'
import type { RawDataset } from './map-types'

function makeManager(beginCoverageLoad = vi.fn(() => Promise.resolve())) {
  const rawDatasets = new Map<string, RawDataset>()
  // NOTE: this worktree is at clean HEAD (pre-P1) — the ctor takes `vtSources`, not
  // the `registerVtSource` callback P1's uncommitted edits introduce. The coverage
  // branch touches only rawDatasets + the background-load kick, so every renderer dep
  // is an inert stub here.
  const mgr = new SourceManager({
    rawDatasets,
    vtSources: new Map(),
    sourceCRS: new Map(),
    geojsonCapPoles: new Map(),
    heatmapPointData: new Map(),
    camera: {} as never,
    canvas: { width: 800 } as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate: vi.fn(),
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: vi.fn(),
    teardownSource: vi.fn(),
    deleteFeatureIndex: vi.fn(),
    beginCoverageLoad,
  } as never)
  return { mgr, rawDatasets, beginCoverageLoad }
}

/** The coverage-source deps the background loader drives, with the arm captured. */
function makeCoverageDeps(rawDatasets: Map<string, RawDataset>) {
  const armed: Array<{ sourceId: string; handle: CoverageHandle; region: string }> = []
  const invalidate = vi.fn()
  const deps: CoverageSourceDeps = {
    rawDatasets,
    renderer: () => ({}) as never,
    time: { nextEpoch: () => 1, isCurrent: () => true } as unknown as CoverageSourceDeps['time'],
    fieldArmed: () => false,
    armFields: () => {},
    armFromShow: (sourceId, handle, region) => {
      armed.push({ sourceId, handle, region })
      return false // no field show in these fixtures — armRegion falls through to the fill arm
    },
    clearArrows: () => {},
    invalidate,
    refresh: { stopAll: () => {} } as unknown as CoverageSourceDeps['refresh'],
    guardedFetch: (label) => (u, init) => shared.safeFetch(String(u), init, label),
    destroyed: () => false,
    runEpoch: () => 0,
    catalogues: new Map(),
    view: () => null,
    watchViewport: () => {},
  }
  return { deps, armed, invalidate }
}

// The committed S-100 HDF5 differential fixture (data/src/hdf5/__fixtures__), read
// as-is — the coverage source reads the standard IN PLACE (ADR-0010), no transcode.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'src',
  'hdf5',
  '__fixtures__',
  'asym_southflip.h5',
)
function coverageBytes(): Uint8Array {
  return readFileSync(FIXTURE)
}

/** Range-capable stub: the coverage source RANGE-streams (only the metadata + the grid it
 *  reads, not the whole cell), so the server must honour Range. Serves 206 slices of the
 *  fixture; the RangeReader drives the same read to the identical handle. */
function stubRangeServer() {
  const bytes = coverageBytes()
  return vi.spyOn(shared, 'safeFetch').mockImplementation(async (_u, init) => {
    const range = (init?.headers as Record<string, string> | undefined)?.['Range']
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (!m) return new Response(bytes, { status: 200 }) as never
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
    const slice = bytes.slice(start, end + 1)
    return new Response(slice, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${start + slice.length - 1}/${bytes.length}` },
    }) as never
  })
}

const URL_ = 'https://tiles.example.com/a.h5'
function load(overrides: Record<string, unknown> = {}) {
  return { name: 'bathy', url: URL_, type: 'coverage', ...overrides } as never
}
const MAPS = {
  usedSourceLayers: new Map(),
  extrudeExprsBySource: new Map(),
  extrudeBaseExprsBySource: new Map(),
  showSlicesBySource: new Map(),
  strokeWidthExprsBySource: new Map(),
  strokeColorExprsBySource: new Map(),
} as never

describe('source-manager: coverage dispatch (A9)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registers an EMPTY region marker and hands the cell to the background loader', async () => {
    // The gate #1426 is about: the attach must not touch the network at all. A fetch here
    // would be a fetch run()'s load barrier waits on, i.e. a black first frame again.
    const fetchSpy = vi.spyOn(shared, 'safeFetch')
    const { mgr, rawDatasets, beginCoverageLoad } = makeManager()

    await mgr._attachOneSource(load(), '', MAPS, { fit: false })

    expect(fetchSpy).not.toHaveBeenCalled()
    const entry = rawDatasets.get('bathy')!
    expect('_coverage' in entry).toBe(true)
    // Registered but with NO resident region — the shape rebuildLayers already handles (it
    // iterates `_coverage`), so the layer arms nothing until the cell lands.
    expect([...(entry as { _coverage: ReadonlyMap<string, unknown> })._coverage.keys()]).toEqual([])
    expect(beginCoverageLoad).toHaveBeenCalledWith('bathy', URL_, undefined)
  })

  it('threads the superseded-run probe to the background loader', async () => {
    // #1153 P1/A7 — the region write lands after an await, so the loader needs the same
    // staleness probe every other post-await write here is guarded by.
    const isStale = () => true
    const { mgr, beginCoverageLoad } = makeManager()
    await mgr._attachOneSource(load(), '', MAPS, { fit: false }, isStale)
    expect(beginCoverageLoad).toHaveBeenCalledWith('bathy', URL_, isStale)
  })

  it('NO `url:` ⇒ host-fed: the source is registered and nothing is loaded (#1426)', async () => {
    // A urlless coverage source already compiles (`url: ""`); without this guard the attach
    // built a URL out of the bare baseUrl and fetched the data DIRECTORY. Omitting `url:` is
    // how a host says it owns residency — the S-111 viewport mosaic is exactly that, and
    // declaring a cell as well made it hold two resident copies of one field.
    const { mgr, rawDatasets, beginCoverageLoad } = makeManager()

    await mgr._attachOneSource(load({ url: '' }), '/data/', MAPS, { fit: false })

    const entry = rawDatasets.get('bathy')!
    expect('_coverage' in entry).toBe(true)
    expect([...(entry as { _coverage: ReadonlyMap<string, unknown> })._coverage.keys()]).toEqual([])
    expect(beginCoverageLoad).not.toHaveBeenCalled()
  })
})

describe('coverage-source: the deferred declared-source load (#1426)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('range-streams via the guarded fetch, writes the region, and arms it', async () => {
    const fetchSpy = stubRangeServer()
    const rawDatasets = new Map<string, RawDataset>([['bathy', { _coverage: new Map() }]])
    const { deps, armed, invalidate } = makeCoverageDeps(rawDatasets)

    await loadDeclaredCoverage(deps, 'bathy', URL_)

    // Range-streamed → multiple fetches, every one SSRF-guarded at the source url.
    expect(fetchSpy).toHaveBeenCalled()
    expect(fetchSpy.mock.calls.every((c) => c[0] === URL_)).toBe(true)
    // A DECLARED source loads exactly one cell, so it must land as a single region under the
    // default key (#1272 E-④); a mosaic adds neighbours beside it later.
    const regions = (
      rawDatasets.get('bathy') as { _coverage: ReadonlyMap<string, CoverageRegionData> }
    )._coverage
    expect([...regions.keys()]).toEqual([DEFAULT_REGION])
    const entry = regions.get(DEFAULT_REGION)!
    // The URL rides along so a later forecast step / refresh can re-read the same cell.
    expect(entry.url).toBe(URL_)
    // The marker's handle is the value-readout authority (valueAt round-trips) — the range
    // path produces the identical handle to the full read.
    expect(entry.handle.valueAt(5, 50)).toBe(10) // SW cell, positive-down verbatim
    expect(Number.isNaN(entry.handle.valueAt(9, 50)!)).toBe(true) // SE nodata
    expect(entry.handle.meta.vertical).toEqual({ datumCode: 23, sign: 'down' })
    // Armed from the LAYER's show (not from the renderer's live display opts — a first arm
    // has no live paint to carry over), and the frame is invalidated so it draws.
    expect(armed).toHaveLength(1)
    expect(armed[0]!.sourceId).toBe('bathy')
    expect(armed[0]!.region).toBe(DEFAULT_REGION)
    expect(invalidate).toHaveBeenCalled()
  })

  it('a non-200 is ISOLATED: it logs, arms nothing, and never throws', async () => {
    // The whole point of the deferral: the scene is already running, so an unreachable cell
    // must leave every other layer drawing (the live demos' documented imagery-only
    // fallback). Before #1426 this rejection propagated out of run()'s load barrier and
    // aborted the mount — a permanently black map.
    vi.spyOn(shared, 'safeFetch').mockResolvedValue(new Response(null, { status: 404 }) as never)
    const errSpy = vi.spyOn(shared.xlog, 'error').mockImplementation(() => {})
    const rawDatasets = new Map<string, RawDataset>([['bathy', { _coverage: new Map() }]])
    const { deps, armed, invalidate } = makeCoverageDeps(rawDatasets)

    await expect(loadDeclaredCoverage(deps, 'bathy', URL_)).resolves.toBeUndefined()

    // Source-attributable, with the status code — the wording the old attach-rejection carried.
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/coverage source "bathy".*404/))
    const regions = (rawDatasets.get('bathy') as { _coverage: ReadonlyMap<string, unknown> })
      ._coverage
    expect([...regions.keys()]).toEqual([])
    expect(armed).toHaveLength(0)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a read that lands on a superseded run arms nothing', async () => {
    stubRangeServer()
    const rawDatasets = new Map<string, RawDataset>([['bathy', { _coverage: new Map() }]])
    const { deps, armed } = makeCoverageDeps(rawDatasets)

    await loadDeclaredCoverage(deps, 'bathy', URL_, () => true)

    const regions = (rawDatasets.get('bathy') as { _coverage: ReadonlyMap<string, unknown> })
      ._coverage
    expect([...regions.keys()]).toEqual([])
    expect(armed).toHaveLength(0)
  })
})

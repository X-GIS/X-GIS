// ═══ source-manager coverage dispatch (#1158, re-platformed by ADR-0010) ═══
//
// The built-in `type: coverage` branch fetches the S-100 HDF5 through safeFetch
// (SSRF guard + 256 MB body cap, mirrored from the geojson branch), reads it IN
// PLACE to a CPU-resident CoverageHandle (readCoverageFromHdf5 — no `.xgcov`
// transcode), and stores the `{ _coverage }` marker. No GPU — the branch touches
// only rawDatasets + the fetch/read path; every injected renderer dep is a stub.
// safeFetch is spied on the shared namespace so the named import resolves to the
// stub at call time (the source-manager-drop-tiling precedent). The fixture is the
// committed asym_southflip.h5 (2×3 S-102 cell: origin [5,50], spacing [2,1], datum
// 23, SW=10 positive-down, SE=nodata) — the reader's own differential fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as shared from '@xgis/shared'
import { SourceManager } from './source-manager'
import type { RawDataset } from './map-types'

function makeManager() {
  const rawDatasets = new Map<string, RawDataset>()
  // NOTE: this worktree is at clean HEAD (pre-P1) — the ctor takes `vtSources`, not
  // the `registerVtSource` callback P1's uncommitted edits introduce. The coverage
  // branch touches only rawDatasets + the fetch/decode path, so every renderer dep
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
  } as never)
  return { mgr, rawDatasets }
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

function load(overrides: Record<string, unknown> = {}) {
  return {
    name: 'bathy',
    url: 'https://tiles.example.com/a.h5',
    type: 'coverage',
    ...overrides,
  } as never
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

  it('decodes via safeFetch and stores a { _coverage } CoverageHandle marker', async () => {
    const bytes = coverageBytes()
    const fetchSpy = vi
      .spyOn(shared, 'safeFetch')
      .mockResolvedValue(new Response(bytes, { status: 200 }) as never)
    const { mgr, rawDatasets } = makeManager()

    await mgr._attachOneSource(load(), '', MAPS, { fit: false })

    expect(fetchSpy).toHaveBeenCalledOnce()
    // the SSRF-guarded url was the fetch target
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://tiles.example.com/a.h5')
    const entry = rawDatasets.get('bathy')!
    expect('_coverage' in entry).toBe(true)
    // the marker's handle is the value-readout authority (valueAt round-trips)
    const handle = (entry as { _coverage: import('@xgis/data').CoverageHandle })._coverage
    expect(handle.valueAt(5, 50)).toBe(10) // SW cell, positive-down verbatim
    expect(Number.isNaN(handle.valueAt(9, 50)!)).toBe(true) // SE nodata
    expect(handle.meta.vertical).toEqual({ datumCode: 23, sign: 'down' })
  })

  it('a non-200 coverage fetch throws a source-attributable error', async () => {
    vi.spyOn(shared, 'safeFetch').mockResolvedValue(new Response(null, { status: 404 }) as never)
    const { mgr } = makeManager()
    await expect(mgr._attachOneSource(load(), '', MAPS, { fit: false })).rejects.toThrow(
      /coverage "bathy".*404/,
    )
  })
})

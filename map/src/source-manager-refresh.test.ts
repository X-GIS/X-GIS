// ═══ SourceManager `refresh:` polling — the actual re-fetch + swap (#1304) ═══
//
// `_attachOneSource` drives a real geojson-URL / custom-loader attach; the
// VectorTileRenderer / VirtualPMTilesBackend construction is stubbed (no GPU device,
// no tiling Worker in the node test env) — same seam-mocking idiom as
// source-manager-bounds-fit-gate.test.ts. `getVtSource: () => null` steers
// `setSourceData`'s reseed onto its teardown+re-attach fallback (rather than the
// `_reseedInPlace` fast path, which needs a fuller VTR/backend double than this suite
// needs) — the fallback still goes through `setSourceData`, the SAME re-seed
// machinery a host data push uses, which is what #1304 asks to reuse. Fake timers
// (vi.useFakeTimers + vi.advanceTimersByTimeAsync) drive the polling loop, mirroring
// coverage-refresh.test.ts's idiom.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { InputStore } from './render/input-store'

class StubVectorTileRenderer {
  setBindGroupLayout(): void {}
  setPaletteResources(): void {}
  setSpriteAtlasView(): void {}
  setExtrudedPipelines(): void {}
  setGroundPipelines(): void {}
  setPatternPipelines(): void {}
  setPatternExtrudedPipelines(): void {}
  setOITPipeline(): void {}
  setLineRenderer(): void {}
  setSource(): void {}
  getBounds(): null {
    return null
  }
}
class StubVirtualPMTilesBackend {
  meta = {
    bounds: [-180, -85, 180, 85] as [number, number, number, number],
    minZoom: 0,
    maxZoom: 14,
    scheme: 'web-mercator-xyz' as const,
    layoutVersion: 3,
  }
  has(): boolean {
    return false
  }
  attach(): void {}
  loadTile(): void {}
  detach(): void {}
}

import * as vtrModule from './render/vector-tile-renderer'
import * as xgisData from '@xgis/data'
import { SourceManager, type SourceManagerDeps } from './source-manager'
import { Camera } from './camera'
import type { ShowSourceMaps } from './show-source-maps'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { MapRendererContent } from '@xgis/map'
import type { GPUContext } from '@xgis/rhi-webgpu'
import type { SceneCommands } from './interpreter'
import type { XGISMapErrorInfo } from './layer'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(vtrModule, 'VectorTileRenderer').mockImplementation(
    (() => new StubVectorTileRenderer()) as never,
  )
  vi.spyOn(xgisData, 'VirtualPMTilesBackend').mockImplementation(
    (() => new StubVirtualPMTilesBackend()) as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function emptyMaps(): ShowSourceMaps {
  return {
    usedSourceLayers: new Map(),
    extrudeExprsBySource: new Map(),
    extrudeBaseExprsBySource: new Map(),
    showSlicesBySource: new Map(),
    strokeWidthExprsBySource: new Map(),
    strokeColorExprsBySource: new Map(),
  } as unknown as ShowSourceMaps
}

function makeSourceManager(overrides: Partial<SourceManagerDeps> = {}) {
  const rendererStub = {} as unknown as MapRendererContent
  const deps: SourceManagerDeps = {
    rawDatasets: new Map(),
    inputs: new InputStore(),
    registerVtSource: () => {},
    sourceCRS: new Map(),
    geojsonCapPoles: new Map(),
    heatmapPointData: new Map(),
    camera: new Camera(0, 0, 2),
    getCanvas: () => ({ width: 1200, height: 800 }) as unknown as HTMLCanvasElement,
    getCtx: () => ({ device: {}, format: 'bgra8unorm' }) as unknown as GPUContext,
    getRenderer: () => rendererStub,
    getLineRenderer: () => null,
    invalidate: () => {},
    fitZoomToLonSpan: () => 9,
    runBoundsFitGate: (apply) => {
      apply()
      return true
    },
    rebuildLayers: () => {},
    // getVtSource: null forces setSourceData's `_vectorTile` branch onto its
    // teardown+re-attach fallback rather than `_reseedInPlace` — still the same
    // public `setSourceData` re-seed path, just not the atomic-swap fast lane.
    teardownSource: () => {},
    fireError: () => {},
    getVtSource: () => null,
    hasVariantSources: () => false,
    deleteFeatureIndex: () => {},
    beginCoverageLoad: () => Promise.resolve(),
    ...overrides,
  }
  return new SourceManager(deps)
}

function geojsonResponse(fc: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(fc))
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    type: 'basic',
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

function fc(id: string): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [2.3, 48.8] },
        properties: { id },
      },
    ],
  }
}

function geojsonLoad(name: string, url: string, refresh: number): SceneCommands['loads'][0] {
  return { name, url, type: 'geojson', refresh }
}

describe('SourceManager `refresh:` polling — geojson URL', () => {
  it('loads once at attach, then re-fetches exactly once per interval and swaps the data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geojsonResponse(fc('v1')))
      .mockResolvedValueOnce(geojsonResponse(fc('v2')))
    vi.stubGlobal('fetch', fetchMock)
    const sm = makeSourceManager()

    await sm._attachOneSource(
      geojsonLoad('s', 'https://example.com/s.geojson', 300),
      '',
      emptyMaps(),
      { fit: true },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('v1'))

    // Not yet due.
    await vi.advanceTimersByTimeAsync(299_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // +300s → exactly one re-fetch, data swapped.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('v2'))
  })

  it('a failed refresh tick keeps the last-good data and fires the typed source error event', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geojsonResponse(fc('v1')))
      .mockRejectedValueOnce(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const fireError = vi.fn((_info: XGISMapErrorInfo) => {})
    const sm = makeSourceManager({ fireError })

    await sm._attachOneSource(
      geojsonLoad('s', 'https://example.com/s.geojson', 60),
      '',
      emptyMaps(),
      { fit: true },
    )
    const lastGood = sm.hostSeededFC.get('s')

    await vi.advanceTimersByTimeAsync(60_000)

    expect(fireError).toHaveBeenCalledTimes(1)
    expect(fireError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'source', source: 's', fatal: false }),
    )
    // Last-good data is untouched — a failed refresh does not tear the source down.
    expect(sm.hostSeededFC.get('s')).toEqual(lastGood)

    // The loop survives the failure and keeps polling.
    fetchMock.mockResolvedValueOnce(geojsonResponse(fc('v3')))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('v3'))
  })

  it('stopAllRefresh() clears the timer — no fetches after teardown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse(fc('v1')))
    vi.stubGlobal('fetch', fetchMock)
    const sm = makeSourceManager()

    await sm._attachOneSource(
      geojsonLoad('s', 'https://example.com/s.geojson', 60),
      '',
      emptyMaps(),
      { fit: true },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    sm.stopAllRefresh()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no further fetches — timer cleared
  })

  it('no `refresh:` declared — no polling loop is armed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse(fc('v1')))
    vi.stubGlobal('fetch', fetchMock)
    const sm = makeSourceManager()

    await sm._attachOneSource(
      { name: 's', url: 'https://example.com/s.geojson', type: 'geojson' },
      '',
      emptyMaps(),
      { fit: true },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('SourceManager `refresh:` polling — custom source-loader (source-loader-seam)', () => {
  it('re-invokes the SAME registered loader on each tick and swaps the result', async () => {
    let call = 0
    const loader = vi.fn(async () => {
      call++
      return { kind: 'fc' as const, data: call === 1 ? fc('v1') : fc('v2') }
    })
    const sm = makeSourceManager({ sourceLoaders: { json: loader } })

    await sm._attachOneSource(
      { name: 's', url: 'https://example.com/s.json', type: 'json', refresh: 60 },
      '',
      emptyMaps(),
      { fit: true },
    )
    expect(loader).toHaveBeenCalledTimes(1)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('v1'))

    await vi.advanceTimersByTimeAsync(60_000)
    expect(loader).toHaveBeenCalledTimes(2)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('v2'))
  })
})

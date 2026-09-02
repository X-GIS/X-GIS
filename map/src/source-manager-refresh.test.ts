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
  reseedTiles(): void {}
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
import { TileCatalog, type GeoJSONFeatureCollection } from '@xgis/data'
import type { MapRendererContent } from '@xgis/map'
import type { GPUContext } from '@xgis/rhi-webgpu'
import type { SceneCommands } from './interpreter'
import type { XGISMapErrorInfo } from './layer'

/** Every VirtualPMTilesBackend option bag constructed during a test, in order —
 *  the re-seed assertions below read the LAST one. */
const backendOpts: Array<Record<string, unknown>> = []

beforeEach(() => {
  vi.useFakeTimers()
  backendOpts.length = 0
  vi.spyOn(vtrModule, 'VectorTileRenderer').mockImplementation(
    (() => new StubVectorTileRenderer()) as never,
  )
  vi.spyOn(xgisData, 'VirtualPMTilesBackend').mockImplementation(((
    opts: Record<string, unknown>,
  ) => {
    backendOpts.push(opts)
    return new StubVirtualPMTilesBackend()
  }) as never)
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

  it('[#1569-class] a stale refresh tick in flight across a scene re-run must NOT overwrite a same-named source re-attached by the new scene', async () => {
    // Scene A: source "s" with refresh armed, isStale scoped to scene A's own epoch.
    let staleA = false
    const isStaleA = (): boolean => staleA

    // The refresh tick's OWN fetch is held pending (a deferred promise) so we can
    // resolve it AFTER simulating the teardown + re-run race window.
    let resolveRefreshFetch!: (r: Response) => void
    const refreshFetchPromise = new Promise<Response>((res) => {
      resolveRefreshFetch = res
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geojsonResponse(fc('A-initial'))) // scene A's initial attach
      .mockImplementationOnce(() => refreshFetchPromise) // scene A's refresh tick — held
      .mockResolvedValueOnce(geojsonResponse(fc('B'))) // scene B's re-attach
    vi.stubGlobal('fetch', fetchMock)
    const sm = makeSourceManager()

    await sm._attachOneSource(
      geojsonLoad('s', 'https://example.com/s.geojson', 60),
      '',
      emptyMaps(),
      { fit: true },
      isStaleA,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // +60s → the refresh tick fires and starts its (held-pending) fetch.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Simulate XGISMap._teardownForReinit(): stopAllRefresh() clears the scheduler
    // (the generation guard stops the tick from RE-ARMING, but the continuation
    // already parked on the held fetch keeps running — that's the hole), and the
    // run-epoch bumps, so scene A's captured `isStale` now reads true.
    sm.stopAllRefresh()
    staleA = true

    // Scene B re-attaches a source with the SAME NAME "s" (a fresh epoch/isStale
    // scope — common across iterations of one .xgis document).
    await sm._attachOneSource(
      { name: 's', url: 'https://example.com/s.geojson', type: 'geojson' },
      '',
      emptyMaps(),
      { fit: true },
      () => false,
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sm.hostSeededFC.get('s')).toEqual(fc('B'))

    // NOW scene A's stale refresh fetch resolves.
    resolveRefreshFetch(geojsonResponse(fc('A-initial')))
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    // Scene B's data must survive untouched — the stale scene-A tick's write is
    // exactly the #1569 ghost-write class (ADJUDICATION FIX). Pre-fix this reads
    // fc('A-initial') instead.
    expect(sm.hostSeededFC.get('s')).toEqual(fc('B'))
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

// ═══ #2299 — a re-seed re-uses the source's OWN attach-time ShowSourceMaps ═══
//
// hunt 2026-09-02: the inline virtual attach used to overwrite one shared
// `_lastShowSourceMaps` slot with the per-source SUBSET map.ts builds for it, so a
// later `setSourceData` / `updateFeature` / `refresh:` tick on a DIFFERENT (URL)
// source re-tiled it with every extrude / stroke / slice descriptor undefined.
describe('SourceManager re-seed — per-source show maps (#2299)', () => {
  const extrudeA = { a: { kind: 'NumberLiteral', value: 50 } }
  const strokeWidthA = { a: { kind: 'NumberLiteral', value: 3 } }

  function mapsForA(): ShowSourceMaps {
    const maps = emptyMaps()
    maps.extrudeExprsBySource.set('a', extrudeA as never)
    maps.strokeWidthExprsBySource.set('a', strokeWidthA as never)
    return maps
  }

  /** An inline (host-fed / `data:`) attach of an unrelated source `b`, carrying only
   *  `b`'s shows — the overwrite that used to poison `a`'s next re-seed. */
  function attachUnrelatedInlineSource(sm: SourceManager): void {
    sm._attachInlineGeoJSONViaVirtualPMTiles('b', fc('b1'), emptyMaps(), new TileCatalog())
  }

  it('teardown+re-attach fallback keeps `a`’s extrude/stroke exprs after an inline attach of `b`', async () => {
    const sm = makeSourceManager()
    await sm._attachGeoJSONViaVirtualPMTiles('a', fc('v1'), mapsForA(), { fit: false })
    expect(backendOpts.at(-1)!.extrudeExprs).toEqual(extrudeA)

    attachUnrelatedInlineSource(sm)
    sm.setSourceData('a', fc('v2'))

    const last = backendOpts.at(-1)!
    expect(last.sourceName).toBe('a')
    expect(last.extrudeExprs).toEqual(extrudeA)
    expect(last.strokeWidthExprs).toEqual(strokeWidthA)
  })

  it('atomic `_reseedInPlace` keeps `a`’s extrude/stroke exprs after an inline attach of `b`', async () => {
    const registered = new Map<string, unknown>()
    const sm = makeSourceManager({
      registerVtSource: (name, source, renderer) => {
        registered.set(name, { source, renderer })
      },
      getVtSource: (id) => (registered.get(id) as never) ?? null,
    })
    await sm._attachGeoJSONViaVirtualPMTiles('a', fc('v1'), mapsForA(), { fit: false })

    attachUnrelatedInlineSource(sm)
    sm.setSourceData('a', fc('v2'))

    const last = backendOpts.at(-1)!
    expect(last.sourceName).toBe('a')
    expect(last.extrudeExprs).toEqual(extrudeA)
    expect(last.strokeWidthExprs).toEqual(strokeWidthA)
  })
})

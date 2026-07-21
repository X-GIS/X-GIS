import { beforeAll, describe, expect, it, vi } from 'vitest'
import { XGISMap } from './map'
import type { GeoJSONFeatureCollection } from '@xgis/data'

// Stub the GeoJSON compile pool so the polygon/line branch's async
// `compile().then()` resolves to an EMPTY tileSet. That branch's
// synchronous outputs (vtSource creation, vectorTileShows push, layer
// registration — everything this spec characterizes) all run BEFORE the
// promise settles; with zero levels the `.then()` skips `addTileLevel`
// and `setRawParts` produces no tiles, so the catalog's `onTileLoaded`
// fan-out never fires the GPU tile-upload path. Without this, the real
// worker-fallback compile + upload runs on a later microtask against our
// inert device and logs `createCommandEncoder is not a function` noise
// AFTER the assertions have already passed. The upload path is downstream
// of `rebuildLayers` and irrelevant to its observable contract.
// Partial-mock @xgis/data: the compile pool now lives in the barrel, so mock the
// whole package but spread the real exports and override ONLY
// getSharedGeoJSONCompilePool (a bare vi.mock('@xgis/data') would blank out every
// other data export the test depends on).
vi.mock('@xgis/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xgis/data')>()),
  getSharedGeoJSONCompilePool: () => ({
    compile: () =>
      Promise.resolve({
        parts: [],
        tileSet: {
          levels: [],
          bounds: [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number],
          featureCount: 0,
          propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
        },
      }),
  }),
}))

// ── Minimal WebGPU globals + device stub ─────────────────────────────
//
// The polygon/line GeoJSON branch of rebuildLayers constructs a real
// VectorTileRenderer and calls `setBindGroupLayout`, which lazily
// allocates a uniform ring via `device.createBuffer({ usage:
// GPUBufferUsage.UNIFORM | ... })`. node has neither the `GPUBufferUsage`
// global nor a real device. We stub the bitflag constants (their exact
// values are irrelevant — nothing reads them back) and an inert device
// whose create* methods return opaque tokens. With null palette / sprite
// views (our renderer mock leaves them null), the VTR's
// `rebuildTileBindGroups` early-returns BEFORE any createBindGroup call,
// so `createBuffer` is the only device method the branch exercises.
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.GPUBufferUsage === undefined) {
    g.GPUBufferUsage = {
      MAP_READ: 0x0001,
      MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004,
      COPY_DST: 0x0008,
      INDEX: 0x0010,
      VERTEX: 0x0020,
      UNIFORM: 0x0040,
      STORAGE: 0x0080,
      INDIRECT: 0x0100,
      QUERY_RESOLVE: 0x0200,
    }
  }
  if (g.GPUTextureUsage === undefined) {
    g.GPUTextureUsage = {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    }
  }
})

/** Inert GPUDevice — VectorTileRenderer's ctor stores it; the
 *  polygon/line branch only calls `createBuffer` (uniform ring). Returns
 *  an opaque object so any `.destroy()` chaining is harmless. */
function mockDevice(): object {
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn(), size: 0 })),
    createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    queue: { writeBuffer: vi.fn() },
  }
}

// ═══ CHARACTERIZATION: source → layer → draw pipeline (`rebuildLayers`) ═══
//
// PURPOSE — This is a SAFETY NET, not a bug hunt. It pins the CURRENT
// observable behaviour of `XGISMap.rebuildLayers()` so the upcoming
// structural decoupling of the XGISMap class can prove the pipeline's
// layer-registration / id-assignment / branch-routing contract is
// unchanged. Every asserted value is whatever today's code produces —
// captured from a live run, asserted EXACTLY. None of these say "this is
// correct"; they say "this is what it does right now".
//
// WHY DRIVE `rebuildLayers` DIRECTLY — `run()` calls `initGPU(canvas)`,
// which needs a real WebGPU device that vitest/node doesn't have. But
// `rebuildLayers` itself is mostly CPU orchestration (layer-id assignment,
// public-wrapper registration, per-show branch routing by source kind /
// geometry type) that only TOUCHES the GPU through a handful of injectable
// collaborators: `renderer`, `pointRenderer`, `rasterRenderer`,
// `lineRenderer`, and `ctx`. We construct the map with a mock canvas (the
// constructor does NO GPU work — confirmed: it only reads option fields),
// then inject lightweight mocks for those collaborators through the same
// private-field test seam the EPSG-ingest + bounds-fit specs already use
// (`map as unknown as { … }`). This exercises the REAL `rebuildLayers`
// method end-to-end without a GPU.
//
// DETERMINISM — `_cameraExplicitlyPositioned` is forced true so the async
// GeoJSON-compile `.then()` (which fits the camera to data bounds) no-ops
// instead of mutating camera state on a microtask. The synchronous outputs
// (layer wrappers, pick ids, vectorTileShows, vtSources, raster wiring,
// pointRenderer.addLayer captures) are all observable the instant
// `rebuildLayers()` returns — no render-loop timing, no frame budget.

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

// ── Injectable mock collaborators ───────────────────────────────────
//
// `rebuildLayers` only ever READS these collaborators' methods/props. The
// GeoJSON polygon/line branch constructs a real VectorTileRenderer (its
// ctor merely stores ctx.device / ctx.format — no device calls), then
// pushes renderer-owned views into it via setters that just stash values.
// So undefined-valued mock props are fine; we record the call surface that
// MATTERS for characterization (clearLayers, point addLayer, raster url).

interface RebuildMocks {
  renderer: {
    clearLayers: ReturnType<typeof vi.fn>
    bindGroupLayout: unknown
    paletteColorAtlasView: unknown
    paletteSampler: unknown
    spriteAtlasView: unknown
    fillPipelineExtruded: unknown
    fillPipelineExtrudedFallback: unknown
    fillPipelineGround: unknown
    fillPipelineGroundFallback: unknown
    fillPipelinePatternGround: unknown
    fillPipelinePatternGroundFallback: unknown
    fillPipelinePatternExtruded: unknown
    fillPipelinePatternExtrudedFallback: unknown
    fillPipelineExtrudedOIT: unknown
  }
  pointRenderer: {
    clearLayers: ReturnType<typeof vi.fn>
    addLayer: ReturnType<typeof vi.fn>
  }
  rasterRenderer: {
    setUrlTemplate: ReturnType<typeof vi.fn>
    setTileSize: ReturnType<typeof vi.fn>
  }
  hillshadeRenderer: {
    setUrlTemplate: ReturnType<typeof vi.fn>
    setParams: ReturnType<typeof vi.fn>
  }
  ctx: { device: object; rhi: object; format: string }
}

function makeMocks(): RebuildMocks {
  return {
    renderer: {
      clearLayers: vi.fn(),
      bindGroupLayout: { __mock: 'bgl' },
      paletteColorAtlasView: null,
      paletteSampler: null,
      spriteAtlasView: null,
      fillPipelineExtruded: null,
      fillPipelineExtrudedFallback: null,
      fillPipelineGround: null,
      fillPipelineGroundFallback: null,
      fillPipelinePatternGround: null,
      fillPipelinePatternGroundFallback: null,
      fillPipelinePatternExtruded: null,
      fillPipelinePatternExtrudedFallback: null,
      fillPipelineExtrudedOIT: null,
    },
    pointRenderer: {
      clearLayers: vi.fn(),
      addLayer: vi.fn(),
    },
    rasterRenderer: {
      setUrlTemplate: vi.fn(),
      setTileSize: vi.fn(),
    },
    hillshadeRenderer: {
      setUrlTemplate: vi.fn(),
      setParams: vi.fn(),
    },
    ctx: {
      device: mockDevice(),
      // #832 M2 — the uniform ring + tile store now route through ctx.rhi.
      rhi: {
        backend: 'webgpu',
        createBuffer: vi.fn(() => ({})),
        writeBuffer: vi.fn(),
        destroyBuffer: vi.fn(),
        unwrapBuffer: vi.fn((b: unknown) => b),
      },
      format: 'bgra8unorm',
    },
  }
}

// Private-field access seam — same `as unknown as` cast pattern as
// map-epsg-ingest-reprojection.test.ts (setSourceCRS) and map-fit-zoom.
type MapInternals = {
  renderer: unknown
  pointRenderer: unknown
  rasterRenderer: unknown
  hillshadeRenderer: unknown
  lineRenderer: unknown
  ctx: unknown
  shapeRegistry: unknown
  rawDatasets: Map<string, GeoJSONFeatureCollection>
  showCommands: unknown[]
  vtSources: Map<string, { source: unknown; renderer: unknown }>
  vectorTileShows: Array<{
    sourceName: string
    show: { layerName?: string; targetName: string; pickId?: number }
    pipelines: unknown
    layout: unknown
  }>
  _rasterShow: { targetName: string } | null
  _hillshadeShow: { targetName: string } | null
  _cameraExplicitlyPositioned: boolean
  rebuildLayers(): void
}

/** Build an XGISMap with mock GPU collaborators wired so the REAL
 *  `rebuildLayers` runs without a GPU device. */
function makeMap(mocks: RebuildMocks): { map: XGISMap; internals: MapInternals } {
  const map = new XGISMap(mockCanvas())
  const internals = map as unknown as MapInternals
  internals.renderer = mocks.renderer
  internals.pointRenderer = mocks.pointRenderer
  internals.rasterRenderer = mocks.rasterRenderer
  internals.hillshadeRenderer = mocks.hillshadeRenderer
  internals.lineRenderer = null // optional in rebuildLayers (guarded)
  internals.ctx = mocks.ctx
  internals.shapeRegistry = null // point branch guards `?? 0`
  // Suppress the async bounds-fit so the GeoJSON-compile microtask is a
  // pure no-op on camera state (keeps the test deterministic).
  internals._cameraExplicitlyPositioned = true
  return { map, internals }
}

// ── ShowCommand fixture factory ─────────────────────────────────────
//
// Mirrors resolved-show.test.ts's `show()` stub: rebuildLayers reads
// targetName / layerName / fill / stroke / strokeWidth / opacity /
// paintShapes / filterExpr / shaderVariant / geometryExpr — the rest is
// irrelevant. Returns `any` because the runtime ShowCommand type carries
// ~50 fields we don't need to populate for this orchestration path.

function show(targetName: string, extras: Record<string, unknown> = {}): any {
  return {
    targetName,
    layerName: extras.layerName ?? targetName,
    fill: extras.fill ?? null,
    stroke: extras.stroke ?? null,
    strokeWidth: (extras.strokeWidth as number) ?? 1,
    opacity: (extras.opacity as number) ?? 1,
    projection: 'mercator',
    visible: true,
    filterExpr: extras.filterExpr ?? null,
    geometryExpr: extras.geometryExpr ?? null,
    shaderVariant: extras.shaderVariant ?? null,
    paintShapes: {
      fill: { fill: null },
      line: {
        stroke: null,
        strokeWidth: { kind: 'constant', value: 1 },
      },
      circle: { size: (extras.sizeShape as unknown) ?? null },
      common: { opacity: { kind: 'constant', value: 1 } },
    },
    ...extras,
  }
}

// ── Data fixtures ───────────────────────────────────────────────────

function polygonFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
        properties: { name: 'block' },
      },
    ],
  }
}

function lineFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        },
        properties: { name: 'road' },
      },
    ],
  }
}

function pointFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0.5, 0.5] },
        properties: { name: 'poi-a' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1.5, 1.5] },
        properties: { name: 'poi-b' },
      },
    ],
  }
}

/** Raster source: rebuildLayers detects `data._tileUrl` and arms the
 *  raster renderer instead of tiling. We tag a near-empty FC with the
 *  private `_tileUrl` marker the runtime sets on raster sources. */
function rasterSource(url: string): GeoJSONFeatureCollection {
  const fc: GeoJSONFeatureCollection = { type: 'FeatureCollection', features: [] }
  ;(fc as unknown as { _tileUrl: string })._tileUrl = url
  return fc
}

/** raster-dem source marker (#777): `{ _tileUrl, _dem: true, encoding, tileSize }`
 *  — rebuildLayers routes a `_dem` marker to the HILLSHADE renderer, not raster. */
function demSource(url: string, encoding = 'mapbox', tileSize = 512): GeoJSONFeatureCollection {
  const fc: GeoJSONFeatureCollection = { type: 'FeatureCollection', features: [] }
  Object.assign(fc as unknown as Record<string, unknown>, {
    _tileUrl: url,
    _dem: true,
    encoding,
    tileSize,
  })
  return fc
}

// ════════════════════════════════════════════════════════════════════

describe('XGISMap.rebuildLayers — characterization (pins current behaviour)', () => {
  describe('scene 1: single polygon source', () => {
    it('registers exactly one public layer wrapper for the polygon show', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()

      const layers = map.getLayers()
      expect(layers).toHaveLength(1)
      expect(layers.map((l) => l.name)).toEqual(['fill'])
    })

    it('assigns pickId 1 to the first registered layer', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      const s = show('blocks', { layerName: 'fill' })
      internals.showCommands = [s]

      internals.rebuildLayers()

      expect(s.pickId).toBe(1)
    })

    it('routes the polygon source into vectorTileShows + registers a vtSource', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()

      expect(internals.vectorTileShows).toHaveLength(1)
      expect(internals.vectorTileShows[0]!.sourceName).toBe('blocks')
      expect([...internals.vtSources.keys()]).toEqual(['blocks'])
    })

    it('clears renderer + point layers before rebuilding', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()

      expect(mocks.renderer.clearLayers).toHaveBeenCalledTimes(1)
      expect(mocks.pointRenderer.clearLayers).toHaveBeenCalledTimes(1)
    })

    it('does NOT arm the raster renderer for a non-raster source', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()

      // setUrlTemplate('') is the unconditional reset at the top; no
      // second call arming an actual URL.
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenCalledTimes(1)
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenCalledWith('')
      expect(internals._rasterShow).toBeNull()
    })
  })

  describe('scene 2: single line source', () => {
    it('routes the line source into vectorTileShows (not the point branch)', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('roads', lineFC())
      internals.showCommands = [
        show('roads', { layerName: 'roads', stroke: '#ff0000', strokeWidth: 2 }),
      ]

      internals.rebuildLayers()

      expect(internals.vectorTileShows).toHaveLength(1)
      expect(internals.vectorTileShows[0]!.sourceName).toBe('roads')
      expect(mocks.pointRenderer.addLayer).not.toHaveBeenCalled()
    })

    it('registers the line layer wrapper under its DSL layerName', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('roads', lineFC())
      internals.showCommands = [show('roads', { layerName: 'roads' })]

      internals.rebuildLayers()

      expect(map.getLayers().map((l) => l.name)).toEqual(['roads'])
    })
  })

  describe('scene 3: point source', () => {
    it('routes Point geometry to pointRenderer.addLayer (skips tiling)', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('pois', pointFC())
      internals.showCommands = [show('pois', { layerName: 'poi', fill: '#00ff00' })]

      internals.rebuildLayers()

      expect(mocks.pointRenderer.addLayer).toHaveBeenCalledTimes(1)
      // Point branch does NOT create a vtSource or push a vectorTileShow.
      expect(internals.vectorTileShows).toHaveLength(0)
      expect(internals.vtSources.size).toBe(0)
    })

    it('passes the FILL color and feature array through to addLayer', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('pois', pointFC())
      internals.showCommands = [show('pois', { layerName: 'poi', fill: '#00ff00' })]

      internals.rebuildLayers()

      const call = mocks.pointRenderer.addLayer.mock.calls[0]!
      const features = call[0] as unknown[]
      const fill = call[1] as [number, number, number, number] | null
      expect(features).toHaveLength(2) // both Point features
      // #00ff00 → parseHexColor → [r, g, b, a] with g=1.
      expect(fill).not.toBeNull()
      expect(fill![1]).toBe(1)
      expect(fill![0]).toBe(0)
      expect(fill![2]).toBe(0)
    })

    it('still registers a public layer wrapper for the point layer', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('pois', pointFC())
      internals.showCommands = [show('pois', { layerName: 'poi' })]

      internals.rebuildLayers()

      expect(map.getLayers().map((l) => l.name)).toEqual(['poi'])
    })
  })

  describe('scene 4: raster source', () => {
    it('arms the raster renderer with the source tile URL', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('basemap', rasterSource('https://tiles/{z}/{x}/{y}.png'))
      internals.showCommands = [show('basemap', { layerName: 'basemap' })]

      internals.rebuildLayers()

      // First call is the reset (''), second arms the real URL.
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenCalledTimes(2)
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenLastCalledWith(
        'https://tiles/{z}/{x}/{y}.png',
      )
    })

    it('captures the raster show as _rasterShow and skips vector tiling', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('basemap', rasterSource('https://tiles/{z}/{x}/{y}.png'))
      const s = show('basemap', { layerName: 'basemap' })
      internals.showCommands = [s]

      internals.rebuildLayers()

      expect(internals._rasterShow).toBe(s)
      expect(internals.vectorTileShows).toHaveLength(0)
      expect(internals.vtSources.size).toBe(0)
    })
  })

  describe('scene 4b: raster-dem source (#777 hillshade routing)', () => {
    it('arms the HILLSHADE renderer (not raster) with the DEM tile URL + decode', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('dem', demSource('https://dem/{z}/{x}/{y}.png', 'terrarium', 256))
      internals.showCommands = [show('dem', { layerName: 'relief' })]

      internals.rebuildLayers()

      // Hillshade armed with the DEM URL (2nd call; 1st is the '' reset).
      expect(mocks.hillshadeRenderer.setUrlTemplate).toHaveBeenLastCalledWith(
        'https://dem/{z}/{x}/{y}.png',
      )
      // DEM decode threaded: terrarium unpack + tileSize 256.
      expect(mocks.hillshadeRenderer.setParams).toHaveBeenCalledWith(
        expect.objectContaining({
          tileSize: 256,
          unpack: { redFactor: 256, greenFactor: 1, blueFactor: 1 / 256, baseShift: 32768 },
        }),
      )
      // The raster renderer is only reset ('') — a DEM source must NOT arm it as colour.
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenCalledTimes(1)
      expect(mocks.rasterRenderer.setUrlTemplate).toHaveBeenCalledWith('')
    })

    it('captures the hillshade show as _hillshadeShow', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('dem', demSource('https://dem/{z}/{x}/{y}.png'))
      const s = show('dem', { layerName: 'relief' })
      internals.showCommands = [s]

      internals.rebuildLayers()

      expect(internals._hillshadeShow).toBe(s)
      expect(internals._rasterShow).toBeNull()
      expect(internals.vectorTileShows).toHaveLength(0)
    })
  })

  describe('scene 5: multi-source scene (polygon + line + point + raster)', () => {
    it('pins layer count, ids, and deterministic pickId assignment order', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.rawDatasets.set('roads', lineFC())
      internals.rawDatasets.set('pois', pointFC())
      internals.rawDatasets.set('basemap', rasterSource('https://t/{z}/{x}/{y}.png'))
      const sFill = show('blocks', { layerName: 'fill' })
      const sRoad = show('roads', { layerName: 'roads' })
      const sPoi = show('pois', { layerName: 'poi' })
      const sBase = show('basemap', { layerName: 'basemap' })
      internals.showCommands = [sFill, sRoad, sPoi, sBase]

      internals.rebuildLayers()

      // Every show gets a wrapper, in declaration order.
      expect(map.getLayers().map((l) => l.name)).toEqual(['fill', 'roads', 'poi', 'basemap'])
      // pickId assigned 1..N in show order regardless of branch taken.
      expect(sFill.pickId).toBe(1)
      expect(sRoad.pickId).toBe(2)
      expect(sPoi.pickId).toBe(3)
      expect(sBase.pickId).toBe(4)
    })

    it('routes each source to the correct sub-pipeline', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.rawDatasets.set('roads', lineFC())
      internals.rawDatasets.set('pois', pointFC())
      internals.rawDatasets.set('basemap', rasterSource('https://t/{z}/{x}/{y}.png'))
      internals.showCommands = [
        show('blocks', { layerName: 'fill' }),
        show('roads', { layerName: 'roads' }),
        show('pois', { layerName: 'poi' }),
        show('basemap', { layerName: 'basemap' }),
      ]

      internals.rebuildLayers()

      // polygon + line → vectorTileShows; point → pointRenderer; raster → rasterRenderer.
      expect(internals.vectorTileShows.map((v) => v.sourceName)).toEqual(['blocks', 'roads'])
      expect([...internals.vtSources.keys()]).toEqual(['blocks', 'roads'])
      expect(mocks.pointRenderer.addLayer).toHaveBeenCalledTimes(1)
      expect(internals._rasterShow!.targetName).toBe('basemap')
    })
  })

  describe('scene 6: two layers sharing one source (same DSL layerName)', () => {
    it('a show whose source has no rawDataset is skipped entirely', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      // 'ghost' has a show but NO rawDataset → `if (!data) continue`.
      internals.showCommands = [
        show('blocks', { layerName: 'fill' }),
        show('ghost', { layerName: 'ghost' }),
      ]

      internals.rebuildLayers()

      // Only the show with backing data produced a wrapper + pickId.
      expect(map.getLayers().map((l) => l.name)).toEqual(['fill'])
      expect(internals.vectorTileShows).toHaveLength(1)
    })

    it('two shows under the SAME layerName share one wrapper and the SAME pickId', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      const sA = show('blocks', { layerName: 'shared' })
      const sB = show('blocks', { layerName: 'shared' })
      internals.showCommands = [sA, sB]

      internals.rebuildLayers()

      // One wrapper for the shared DSL name (second show adopts it).
      expect(map.getLayers().map((l) => l.name)).toEqual(['shared'])
      // LayerIdRegistry.register returns the SAME id for a repeated name.
      expect(sA.pickId).toBe(1)
      expect(sB.pickId).toBe(1)
    })
  })

  describe('scene 7: zoom-dependent paint (filter does not change routing)', () => {
    it('a filtered polygon show still registers + routes to vectorTileShows', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      // A filter expr is present; routing is unchanged (filtered key path).
      internals.showCommands = [
        show('blocks', {
          layerName: 'filtered-fill',
          filterExpr: { ast: { type: 'BoolLit', value: true } as unknown },
        }),
      ]

      internals.rebuildLayers()

      expect(map.getLayers().map((l) => l.name)).toEqual(['filtered-fill'])
      expect(internals.vectorTileShows).toHaveLength(1)
    })
  })

  describe('idempotency / re-projection contract', () => {
    it('a second rebuildLayers reassigns the SAME deterministic pickIds', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.rawDatasets.set('roads', lineFC())
      const sFill = show('blocks', { layerName: 'fill' })
      const sRoad = show('roads', { layerName: 'roads' })
      internals.showCommands = [sFill, sRoad]

      internals.rebuildLayers()
      const firstFill = sFill.pickId
      const firstRoad = sRoad.pickId

      internals.rebuildLayers()

      // Same addLayer order → same ids (the registry resets each rebuild).
      expect(sFill.pickId).toBe(firstFill)
      expect(sRoad.pickId).toBe(firstRoad)
      expect(firstFill).toBe(1)
      expect(firstRoad).toBe(2)
    })

    it('a second rebuildLayers produces fresh layer wrappers (old refs replaced)', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()
      const firstWrapper = map.getLayer('fill')

      internals.rebuildLayers()
      const secondWrapper = map.getLayer('fill')

      expect(firstWrapper).not.toBeNull()
      expect(secondWrapper).not.toBeNull()
      // xgisLayers is cleared + repopulated → a NEW wrapper instance.
      expect(secondWrapper).not.toBe(firstWrapper)
    })

    it('clearLayers fires once per rebuild', () => {
      const mocks = makeMocks()
      const { internals } = makeMap(mocks)
      internals.rawDatasets.set('blocks', polygonFC())
      internals.showCommands = [show('blocks', { layerName: 'fill' })]

      internals.rebuildLayers()
      internals.rebuildLayers()

      expect(mocks.renderer.clearLayers).toHaveBeenCalledTimes(2)
      expect(mocks.pointRenderer.clearLayers).toHaveBeenCalledTimes(2)
    })
  })

  describe('empty scene', () => {
    it('produces zero layers and zero draws with no shows', () => {
      const mocks = makeMocks()
      const { map, internals } = makeMap(mocks)
      internals.showCommands = []

      internals.rebuildLayers()

      expect(map.getLayers()).toHaveLength(0)
      expect(internals.vectorTileShows).toHaveLength(0)
      expect(internals.vtSources.size).toBe(0)
      expect(mocks.pointRenderer.addLayer).not.toHaveBeenCalled()
      // Top-of-method resets still ran exactly once.
      expect(mocks.renderer.clearLayers).toHaveBeenCalledTimes(1)
    })
  })
})

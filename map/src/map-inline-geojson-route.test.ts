// #1837 — route selection for inline (rawDatasets-seeded) GeoJSON sources.
//
// FAIL-BEFORE (recorded against the unfixed tree, this file unchanged — 2 failed | 7 passed):
//   × routes an unfiltered, non-procedural inline source through the virtual attach with NO flag set
//     AssertionError: expected "_attachInlineGeoJSONViaVirtualPMTiles" to be called 1 times, but got 0 times
//   × declares a slice under exactly the key the VTR looks up, for every show on the source
//     (same assertion — the attach never ran, so there was no `maps` argument to read)
// The five cases that DO pass on the unfixed tree are the ones whose route the fix
// must not move: both explicit opt-ins, the `?legacy=1` opt-out, filtered, procedural.
//
// WHAT THIS PINS — an importer-seeded inline source (an imported Mapbox style's
// `source.data`, landed in `rawDatasets` by run()'s inline-GeoJSON seed loop) must
// take the VirtualPMTiles route WITHOUT `?virt_inline=1` / the window flag. On the
// legacy route the GeoJSON runtime backend stores every tile under the default ''
// slice (`tile-catalog.ts` cacheTileData: `d.sourceLayer ?? ''`) while the VTR looks
// up `computeSliceKey(show.sourceLayer || show.targetName || '', filter)` — a
// permanent cache miss since 788e2282, i.e. a blank frame for the shipped
// `import_mapbox_inline_geojson` demo (three e2e witnesses at fill 0.00%).
//
// SEAM — the same private-field injection the rebuildLayers characterization spec
// uses (`map as unknown as { … }`): `rebuildLayers` is CPU orchestration that only
// touches the GPU through injectable collaborators. `VectorTileRenderer` is stubbed
// on the shared module namespace (as source-manager-drop-tiling.test.ts does) so no
// device is needed; the two route endpoints — `SourceManager.
// _attachInlineGeoJSONViaVirtualPMTiles` and the shared compile pool's `compile` —
// are spies, so which one runs IS the observation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeSliceKey, type GeoJSONFeatureCollection } from '@xgis/data'
import * as vtrModule from './render/vector-tile-renderer'
import type { ShowSourceMaps } from './show-source-maps'
import { XGISMap } from './map'

// Legacy endpoint. Resolving an EMPTY tileSet keeps the `.then()` inert (no
// addTileLevel / setRawParts against our stub renderer) — the route decision it
// records is synchronous and complete the moment `compile` is called.
const compileSpy = vi.hoisted(() => vi.fn())
vi.mock('@xgis/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xgis/data')>()),
  getSharedGeoJSONCompilePool: () => ({ compile: compileSpy }),
}))

/** VTR needs a real GPU device for its uniform ring; nothing in the route decision
 *  reads it back, so every setter the branch calls is an inert no-op here. */
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
  setFillRhi(): void {}
  setSource(): void {}
  setComputePlan(): void {}
  hasFeatureData(): boolean {
    return false
  }
  buildFeatureDataBuffer(): void {}
}

type MapInternals = {
  renderer: unknown
  pointRenderer: unknown
  heatmapRenderer: unknown
  rasterRenderer: unknown
  hillshadeRenderer: unknown
  coverageRenderer: unknown
  lineRenderer: unknown
  ctx: unknown
  shapeRegistry: unknown
  sourceManager: { _attachInlineGeoJSONViaVirtualPMTiles: (...a: unknown[]) => void }
  rawDatasets: Map<string, GeoJSONFeatureCollection>
  showCommands: unknown[]
  _cameraExplicitlyPositioned: boolean
  rebuildLayers(): void
}

/** The inline FeatureCollection the `import_mapbox_inline_geojson` fixture carries
 *  (playground/public/sample-mapbox-with-inline-geojson.json): two constant-colour
 *  annotation boxes, no filter, no procedural geometry. */
function annotationsFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [126.5, 37.3],
              [127.4, 37.3],
              [127.4, 37.7],
              [126.5, 37.7],
              [126.5, 37.3],
            ],
          ],
        },
        properties: { id: 'seoul-box' },
      },
    ],
  }
}

// `any` mirrors the rebuildLayers characterization spec's `show()` stub: the runtime
// ShowCommand carries ~50 fields and the route decision reads only these.
function show(targetName: string, extras: Record<string, unknown> = {}): any {
  return {
    targetName,
    layerName: extras.layerName ?? targetName,
    sourceLayer: undefined,
    fill: '#e11d48',
    stroke: null,
    strokeWidth: 1,
    opacity: 1,
    projection: 'mercator',
    visible: true,
    filterExpr: extras.filterExpr ?? null,
    geometryExpr: extras.geometryExpr ?? null,
    shaderVariant: null,
    paintShapes: {
      fill: { fill: null },
      line: { stroke: null, strokeWidth: { kind: 'constant', value: 1 } },
      circle: { size: null },
      common: { opacity: { kind: 'constant', value: 1 } },
    },
    ...extras,
  }
}

/** Route endpoints observed for one `rebuildLayers()` run. */
interface Route {
  attach: ReturnType<typeof vi.fn>
  internals: MapInternals
}

function makeMap(): Route {
  const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
  const internals = map as unknown as MapInternals
  internals.renderer = { clearLayers: vi.fn() }
  internals.pointRenderer = null
  internals.heatmapRenderer = null
  internals.rasterRenderer = { setUrlTemplate: vi.fn(), setTileSize: vi.fn() }
  internals.hillshadeRenderer = { setUrlTemplate: vi.fn() }
  internals.coverageRenderer = { clear: vi.fn() }
  internals.lineRenderer = null
  internals.ctx = {}
  internals.shapeRegistry = null
  // Suppress the legacy branch's async camera-fit so neither route mutates camera
  // state on a microtask (`_runBoundsFitGate` returns early).
  internals._cameraExplicitlyPositioned = true
  const attach = vi
    .spyOn(internals.sourceManager, '_attachInlineGeoJSONViaVirtualPMTiles')
    .mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>
  return { attach, internals }
}

/** `window` is absent under the node test environment, and the gate is browser-only
 *  by construction (in production `rebuildLayers` runs after a GPU boot against a
 *  canvas). Install the minimum the flag reads touch. */
function installWindow(search: string, flags: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window?: unknown }).window = {
    location: { search },
    ...flags,
  }
}

beforeEach(() => {
  compileSpy.mockReset()
  compileSpy.mockResolvedValue({
    parts: [],
    tileSet: {
      levels: [],
      bounds: [Infinity, Infinity, -Infinity, -Infinity],
      featureCount: 0,
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
    },
  })
  vi.spyOn(vtrModule, 'VectorTileRenderer').mockImplementation(
    (() => new StubVectorTileRenderer()) as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('rebuildLayers — inline GeoJSON route selection (#1837)', () => {
  it('routes an unfiltered, non-procedural inline source through the virtual attach with NO flag set', () => {
    installWindow('')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations', { layerName: 'annotation-fill' })]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0][0]).toBe('annotations')
    expect(compileSpy).toHaveBeenCalledTimes(0)
  })

  it('still routes virt for the ?virt_inline=1 opt-in (unchanged)', () => {
    installWindow('?virt_inline=1')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations')]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(1)
    expect(compileSpy).toHaveBeenCalledTimes(0)
  })

  it('still routes virt for the __XGIS_USE_VIRTUAL_INLINE_GEOJSON opt-in (unchanged)', () => {
    installWindow('', { __XGIS_USE_VIRTUAL_INLINE_GEOJSON: true })
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations')]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(1)
    expect(compileSpy).toHaveBeenCalledTimes(0)
  })

  it('honours the ?legacy=1 opt-out — the legacy compile still owns the source', () => {
    installWindow('?legacy=1')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations')]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(0)
    expect(compileSpy).toHaveBeenCalledTimes(1)
  })

  it('an explicit virt_inline opt-in outranks the generic ?legacy=1 opt-out', () => {
    installWindow('?legacy=1&virt_inline=1')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations')]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(1)
    expect(compileSpy).toHaveBeenCalledTimes(0)
  })

  // The two shapes the virtual inline attach is NOT proven for stay exactly where
  // #938 left them. A filtered show gets its own `target__N` vtKey, which
  // buildShowSourceMaps (bucketed by targetName) declares no slice for; a
  // geometryExpr show reads raw features rather than tile geometry.
  it('leaves a FILTERED show on the legacy route', () => {
    installWindow('')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [
      show('annotations', { filterExpr: { ast: { kind: 'BooleanLiteral', value: true } } }),
    ]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(0)
    expect(compileSpy).toHaveBeenCalledTimes(1)
  })

  it('leaves a PROCEDURAL (geometryExpr) show on the legacy route', () => {
    installWindow('')
    const { attach, internals } = makeMap()
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [
      show('annotations', { geometryExpr: { ast: { kind: 'NumberLiteral', value: 1 } } }),
    ]

    internals.rebuildLayers()

    expect(attach).toHaveBeenCalledTimes(0)
    expect(compileSpy).toHaveBeenCalledTimes(1)
  })
})

// ── The invariant the whole bug class violates ──────────────────────────────
//
// STORAGE KEY == LOOKUP KEY. The worker emits one slice per descriptor in
// `showSlicesBySource`, keyed by that descriptor's `sliceKey`; the VTR reads
// `computeSliceKey(show.sourceLayer || show.targetName || '', filterAst)` (vector-
// tile-renderer.ts:1074-1075 and 2473-2474). A route is only correct when the two
// agree for EVERY show riding the source — which is precisely what the legacy route
// cannot do for a named source, because it stores under ''.
describe('inline route slice-key agreement (#1837)', () => {
  it('declares a slice under exactly the key the VTR looks up, for every show on the source', () => {
    installWindow('')
    const { attach, internals } = makeMap()
    const shows = [
      show('annotations', { layerName: 'annotation-fill' }),
      show('annotations', { layerName: 'annotation-stroke' }),
    ]
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = shows

    internals.rebuildLayers()

    // Attached ONCE, on the first show; later shows reuse the registered vt source.
    expect(attach).toHaveBeenCalledTimes(1)
    const [vtKey, , maps] = attach.mock.calls[0] as [string, unknown, ShowSourceMaps]
    const declared = new Set((maps.showSlicesBySource.get(vtKey) ?? []).map((s) => s.sliceKey))
    expect(declared.size).toBeGreaterThan(0)
    for (const s of shows) {
      const lookup = computeSliceKey(s.sourceLayer || s.targetName || '', s.filterExpr?.ast ?? null)
      expect(declared.has(lookup)).toBe(true)
    }
  })

  it("the legacy route's default '' slot cannot serve that lookup key", () => {
    // `TileCatalog.cacheTileData` stores `d.sourceLayer ?? ''` and `getTileData`
    // returns `slot.get(sourceLayer) ?? null` for any non-empty key — so a named
    // source on the legacy route is a permanent miss, no matter what it compiled.
    expect(computeSliceKey('annotations', null)).not.toBe('')
  })
})

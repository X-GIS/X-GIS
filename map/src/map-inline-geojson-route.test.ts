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
import { tileKey, type GeometryPart, type TileLevel } from '@xgis/compiler'
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
  vtSources: Map<string, { source: CatalogProbe }>
  rebuildLayers(): void
}

/** The TileCatalog surface the #1940 assertions read — which slot a tile
 *  actually landed in, and the on-demand compile that produces the empty
 *  placeholder. */
interface CatalogProbe {
  hasTileData(key: number, sliceLayer?: string): boolean
  getTileData(
    key: number,
    sliceLayer?: string,
  ): { vertices: Float32Array; indices: Uint32Array } | null
  resetCompileBudget(frameId?: number): void
  compileTileOnDemand(key: number): boolean
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

  it("a named source's lookup key is never the anonymous '' slot", () => {
    // `TileCatalog.cacheTileData` stores `d.sourceLayer ?? ''` and `getTileData`
    // returns `slot.get(sourceLayer) ?? null` for any non-empty key — so ANY route
    // that writes the anonymous slot for a named source is a permanent miss, no
    // matter what it compiled. #1940 is that miss on the legacy route; the
    // describe below pins the storage side of the agreement.
    expect(computeSliceKey('annotations', null)).not.toBe('')
  })
})

// ── #1940 — the same invariant, on the LEGACY route's own storage ───────────
//
// The legacy route compiles in-process instead of asking a worker for slices, so
// nothing external declares its slice key: the catalog's own two writes ARE the
// storage authority — the pre-compiled z0 level (`addTileLevel`) and the runtime
// backend's on-demand tiles (`setRawParts` → `GeoJSONRuntimeBackend.acceptResult`).
// Both wrote the anonymous '' slot while the VTR asked for
// `computeSliceKey(sourceLayer || targetName, filter)`, so every legacy-route
// source drew nothing — `?legacy=1` for URL GeoJSON (measured: styled_world's
// legacy arm at oceanRatio 0, darkRatio 1) and filtered / procedural inline shows
// on the DEFAULT route, which the route gate keeps here in every configuration.
//
// FAIL-BEFORE (recorded against the unfixed tree, this file's other cases green):
//   × stores the pre-compiled z0 level under the key the VTR looks up
//     AssertionError: expected false to be true // Object.is equality
describe('legacy route slice-key agreement (#1940)', () => {
  const Z0 = tileKey(0, 0, 0)
  /** z=6 over the eastern Pacific — inside the backend's zoom range, outside the
   *  fixture's z=3 grid cell, so `compileSync` takes the empty-placeholder
   *  branch. */
  const PACIFIC = tileKey(6, 10, 30)

  /** One z0 tile carrying a single triangle: enough for `addTileLevel` to cache a
   *  slice under whatever key the route hands it. */
  function oneTileLevel(): TileLevel {
    return {
      zoom: 0,
      tiles: new Map([
        [
          Z0,
          {
            z: 0,
            x: 0,
            y: 0,
            tileWest: -180,
            tileSouth: -85.0511,
            vertices: new Float32Array(18),
            dequantScale: 1,
            dequantHalf: 0,
            indices: new Uint32Array([0, 1, 2]),
            lineVertices: new Float32Array(0),
            lineIndices: new Uint32Array(0),
            outlineIndices: new Uint32Array(0),
            outlineVertices: new Float32Array(0),
            outlineLineIndices: new Uint32Array(0),
            featureCount: 1,
          },
        ],
      ]),
    }
  }

  /** The Seoul box as the worker would hand it back — feeds `setRawParts`, so the
   *  runtime backend has a grid to miss against. */
  const seoulPart: GeometryPart = {
    type: 'polygon',
    rings: [
      [
        [126.5, 37.3],
        [127.4, 37.3],
        [127.4, 37.7],
        [126.5, 37.7],
        [126.5, 37.3],
      ],
    ],
    featureIndex: 0,
    minLon: 126.5,
    minLat: 37.3,
    maxLon: 127.4,
    maxLat: 37.7,
  }

  /** Drive one legacy-route rebuild to completion and hand back the catalog the
   *  route registered under `vtKey`. */
  async function runLegacy(vtKey: string, extras: Record<string, unknown>): Promise<CatalogProbe> {
    installWindow('?legacy=1')
    const { attach, internals } = makeMap()
    compileSpy.mockResolvedValue({
      parts: [seoulPart],
      tileSet: {
        levels: [oneTileLevel()],
        bounds: [126.5, 37.3, 127.4, 37.7],
        featureCount: 1,
        propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      },
    })
    internals.rawDatasets.set('annotations', annotationsFC())
    internals.showCommands = [show('annotations', extras)]

    internals.rebuildLayers()

    // The route under test IS the legacy one — a virt attach here would make
    // every assertion below vacuous.
    expect(attach).toHaveBeenCalledTimes(0)
    expect(compileSpy).toHaveBeenCalledTimes(1)
    // Let the compile promise's `.then()` (addTileLevel + setRawParts) settle.
    await new Promise((r) => setTimeout(r, 0))
    const catalog = internals.vtSources.get(vtKey)?.source
    expect(catalog, `no catalog registered under "${vtKey}"`).toBeTruthy()
    return catalog!
  }

  it('stores the pre-compiled z0 level under the key the VTR looks up', async () => {
    const catalog = await runLegacy('annotations', { layerName: 'annotation-fill' })
    const lookup = computeSliceKey('annotations', null)

    expect(catalog.hasTileData(Z0, lookup), `z0 tile missing from slice "${lookup}"`).toBe(true)
    // The tile in that slot is the one the compile produced, not a placeholder.
    expect(catalog.getTileData(Z0, lookup)?.indices.length).toBe(3)
    // Key-sensitivity: the query distinguishes slots, so the line above carries
    // information. (`hasTileData(k, '')` cannot serve as this contrast — an empty
    // sourceLayer is the slice-AGNOSTIC query, tile-catalog.ts:589-593, and
    // answers `slot.size > 0` for ANY slice.)
    expect(catalog.hasTileData(Z0, `${lookup}__decoy`)).toBe(false)
  })

  it("the runtime backend's empty placeholder lands in that same slot", async () => {
    const catalog = await runLegacy('annotations', { layerName: 'annotation-fill' })
    const lookup = computeSliceKey('annotations', null)

    catalog.resetCompileBudget()
    expect(catalog.compileTileOnDemand(PACIFIC), 'backend refused the key').toBe(true)

    // The empty-placeholder contract (tile-decision.ts:228-240) is preserved, not
    // removed: the placeholder still exists and still carries zero geometry — it
    // is simply in the slot the VTR asks about, so `hasNonEmptySliceInCatalog`
    // can see it is empty and let it fall through to drop-empty.
    expect(catalog.hasTileData(PACIFIC, lookup)).toBe(true)
    expect(catalog.getTileData(PACIFIC, lookup)?.vertices.length).toBe(0)
    expect(catalog.getTileData(PACIFIC, lookup)?.indices.length).toBe(0)
  })

  it('a FILTERED show stores under its filter-hashed key, not its vtKey', async () => {
    // The decoy: a filtered show's vtKey is `annotations__0` (an ordinal, assigned
    // by `vectorTileShows.length`), while the VTR looks up
    // `computeSliceKey('annotations', ast)` = `annotations::<hash>`. Storing under
    // the vtKey would satisfy the first case above and still render nothing here.
    const filterExpr = { ast: { kind: 'BooleanLiteral', value: true } }
    const catalog = await runLegacy('annotations__0', { filterExpr })
    const lookup = computeSliceKey('annotations', filterExpr.ast)

    expect(lookup).not.toBe('annotations__0')
    expect(catalog.hasTileData(Z0, lookup), `z0 tile missing from slice "${lookup}"`).toBe(true)
    expect(catalog.hasTileData(Z0, 'annotations__0')).toBe(false)
    // ...and not under the UNFILTERED key either: the filter hash is part of the
    // slot name, exactly as it is part of the VTR's lookup.
    expect(catalog.hasTileData(Z0, 'annotations')).toBe(false)
  })
})

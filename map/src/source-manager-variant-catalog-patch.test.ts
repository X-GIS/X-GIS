// ═══ #1800: filtered-show `__N` variant catalogs must not go stale on the ═══
// ═══ in-place fast paths ══════════════════════════════════════════════════
//
// A source with a FILTERED show gets a second TileCatalog registered under
// `${id}__N` (its own seeded subset). #1371's `_reseedInPlace` (via
// setSourceData) and #1375's `patchFeaturesInPlace` both resolve ONLY the
// base catalog through `getVtSource(sourceId)` — neither enumerates sibling
// `__N` entries. Left unguarded, a fast-path update patches the base,
// reports success, and leaves every variant serving the pre-update subset
// until something forces a full teardown.
//
// The fix (conservative, shape (b) from the issue): both fast paths now
// query `hasVariantSources(sourceId)` first and refuse whenever a variant
// exists, so the caller falls back to the existing full teardown/rebuild
// path — the only path that walks every variant (via rebuildLayers()).
//
// Fixture idioms borrowed from source-manager-drop-tiling.test.ts (stub
// VectorTileRenderer / VirtualPMTilesBackend, spy the tiling-pool functions,
// keep TileCatalog REAL) and data/src/point-feature-patch.test.ts (the
// `acceptResult` escape hatch to seed a resident tile without a real
// backend round-trip).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InputStore } from './render/input-store'
import * as xgisData from '@xgis/data'
import * as vtrModule from './render/vector-tile-renderer'
import type { VectorTileRenderer } from './render/vector-tile-renderer'
import { SourceManager } from './source-manager'
import { TileCatalog, TILE_LAYOUT_VERSION } from '@xgis/data'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { ShowSourceMaps } from './show-source-maps'
import { lonLatToMercF64, packECEFPointFeatures, tileKey } from '@xgis/compiler'
import { hasVariantCatalogs } from './map-teardown'

// ── Stubs (no GPU / no real Worker) — mirrors source-manager-drop-tiling.test.ts ──
class StubVectorTileRenderer {
  reseedTiles = vi.fn()
  // #2439 — the reseed-in-place path re-seeds the dense `categorical()` value
  // lists before it re-seeds the tiles. A `vi.fn()` rather than a no-op setter
  // because the control test below now ASSERTS the forwarding: an unconditional
  // production call against an incomplete double is how this surfaced (a
  // TypeError inside setSourceData, which is far worse than a stale rank).
  setSeededFeatures = vi.fn()
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
}
class StubVirtualPMTilesBackend {
  meta = {
    bounds: [-180, -85, 180, 85] as [number, number, number, number],
    minZoom: 0,
    maxZoom: 14,
    scheme: 'web-mercator-xyz' as const,
    layoutVersion: TILE_LAYOUT_VERSION,
  }
  has(): boolean {
    return false
  }
  attach(): void {}
  loadTile(): void {}
  detach(): void {}
}

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

type Entry = { source: TileCatalog; renderer: StubVectorTileRenderer }

function makeManager() {
  const registered = new Map<string, Entry>()
  const rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  const teardownSource = vi.fn()
  const rebuildLayers = vi.fn()
  const invalidate = vi.fn()
  const order: string[] = []

  const mgr = new SourceManager({
    rawDatasets,
    inputs: new InputStore(),
    registerVtSource: (key, source, renderer) => {
      registered.set(key, { source, renderer: renderer as unknown as StubVectorTileRenderer })
    },
    sourceCRS: new Map(),
    geojsonCapPoles: new Map(),
    heatmapPointData: new Map(),
    camera: {} as never,
    getCanvas: () => ({ width: 800 }) as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate,
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => {
      order.push('rebuild')
      rebuildLayers()
    },
    teardownSource: (id) => {
      order.push('teardown')
      teardownSource(id)
    },
    fireError: () => {},
    getVtSource: (id) => {
      const e = registered.get(id)
      return e ? (e as unknown as { source: TileCatalog; renderer: VectorTileRenderer }) : null
    },
    hasVariantSources: (id) => hasVariantCatalogs(registered, id),
    deleteFeatureIndex: () => {},
    beginCoverageLoad: () => Promise.resolve(),
  })
  return { mgr, rawDatasets, registered, teardownSource, rebuildLayers, invalidate, order }
}

const SOURCE_ID = 'currents'
const VARIANT_KEY = `${SOURCE_ID}__1`

const BASE_FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 77, geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
  ],
} as GeoJSONFeatureCollection

const PATCHED_FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 77, geometry: { type: 'Point', coordinates: [20, 30] }, properties: {} },
  ],
} as GeoJSONFeatureCollection

async function attachBase(mgr: SourceManager): Promise<void> {
  await mgr._attachGeoJSONViaVirtualPMTiles(SOURCE_ID, BASE_FC, emptyMaps(), { fit: false })
}

/** Pack `[lon, lat, packedIdx]` triples the way the tiler does. `packedIdx` is
 *  NOT the stable feature id (that's the `pointFeatureIds` side-car passed to
 *  `seed` below) — it is left at 0 throughout, matching
 *  data/src/point-feature-patch.test.ts's own fixture shape. */
function packPoints(pts: readonly [number, number, number][]): Float32Array {
  const scratch: number[] = []
  for (const [lon, lat, packedIdx] of pts) {
    const [mx, my] = lonLatToMercF64(lon, lat)
    scratch.push(mx, my, packedIdx)
  }
  return packECEFPointFeatures(scratch)
}

/** Seed a REAL TileCatalog with one resident point tile via the same
 *  `acceptResult` escape hatch the data-package patch tests use — no real
 *  backend round-trip needed. Tile z2/x2/y1: lon [0, 90], lat [0, 66.51]. */
function seed(catalog: TileCatalog, key: number, fid: number, lon = 10, lat = 10): void {
  const empty = new Float32Array(0)
  const emptyI = new Uint32Array(0)
  ;(
    catalog as unknown as {
      acceptResult(key: number, result: unknown, sourceLayer?: string): void
    }
  ).acceptResult(
    key,
    {
      vertices: empty,
      dequantScale: 1,
      dequantHalf: 0,
      indices: emptyI,
      lineVertices: empty,
      lineIndices: emptyI,
      pointVertices: packPoints([[lon, lat, 0]]),
      pointFeatureIds: Uint32Array.of(fid),
    },
    'pts',
  )
}

beforeEach(() => {
  vi.spyOn(xgisData, 'newTilingInstanceId').mockImplementation(() => 'gjt-1800-test')
  vi.spyOn(xgisData, 'dropSource').mockImplementation((() => {}) as never)
  vi.spyOn(xgisData, 'setSource').mockImplementation((() => {}) as never)
  vi.spyOn(xgisData, 'getTile').mockImplementation((() => {}) as never)
  vi.spyOn(vtrModule, 'VectorTileRenderer').mockImplementation(
    (() => new StubVectorTileRenderer()) as never,
  )
  vi.spyOn(xgisData, 'VirtualPMTilesBackend').mockImplementation(
    (() => new StubVirtualPMTilesBackend()) as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hasVariantCatalogs (#1800) — the single id/id__N authority', () => {
  it('is false with only the base entry registered', () => {
    const vtSources = new Map([['pts', {}]])
    expect(hasVariantCatalogs(vtSources, 'pts')).toBe(false)
  })

  it('is true once a filtered-show variant is registered alongside the base', () => {
    const vtSources = new Map([
      ['pts', {}],
      ['pts__1', {}],
    ])
    expect(hasVariantCatalogs(vtSources, 'pts')).toBe(true)
  })

  it('does not false-positive on an unrelated source sharing a prefix', () => {
    const vtSources = new Map([
      ['pts', {}],
      ['pts-extra', {}], // no `__` separator — not a variant of "pts"
    ])
    expect(hasVariantCatalogs(vtSources, 'pts')).toBe(false)
  })
})

describe('SourceManager.patchFeaturesInPlace (#1375) — variant staleness (#1800)', () => {
  it('#1800 red-today: refuses the fast path once a filtered-show variant catalog exists', async () => {
    const { mgr, registered } = makeManager()
    await attachBase(mgr)
    const key = tileKey(2, 2, 1)
    seed(registered.get(SOURCE_ID)!.source, key, 77)
    const variantCatalog = new TileCatalog()
    registered.set(VARIANT_KEY, { source: variantCatalog, renderer: new StubVectorTileRenderer() })
    seed(variantCatalog, key, 77)

    const ok = mgr.patchFeaturesInPlace(SOURCE_ID, PATCHED_FC, [
      { featureId: 77, lon: 20, lat: 30 },
    ])

    // RED on pre-#1800 code: `patchFeaturesInPlace` had no variant check, so it
    // patched the base catalog and returned true — leaving VARIANT_KEY (a
    // sibling catalog for the SAME sourceId) serving the stale pre-update
    // position forever. This line alone is red pre-fix (actual: true).
    expect(ok, '#1800 — must refuse in place once a filtered-show variant catalog exists').toBe(
      false,
    )

    // All-or-nothing: a refusal must not silently patch the base either. This
    // is ALSO red pre-fix (the base WOULD read the patched position here).
    const unchanged = Array.from(packPoints([[10, 10, 0]]))
    expect(
      Array.from(registered.get(SOURCE_ID)!.source.getTileData(key, 'pts')!.pointVertices!),
    ).toEqual(unchanged)
    // The variant was never reachable either way — pinned so a future change
    // cannot "fix" this by quietly patching only the base.
    expect(Array.from(variantCatalog.getTileData(key, 'pts')!.pointVertices!)).toEqual(unchanged)
  })

  it('control: still patches in place when no variant catalog exists', async () => {
    const { mgr, registered } = makeManager()
    await attachBase(mgr)
    const key = tileKey(2, 2, 1)
    seed(registered.get(SOURCE_ID)!.source, key, 77)

    const ok = mgr.patchFeaturesInPlace(SOURCE_ID, PATCHED_FC, [
      { featureId: 77, lon: 20, lat: 30 },
    ])

    expect(ok).toBe(true)
    expect(
      Array.from(registered.get(SOURCE_ID)!.source.getTileData(key, 'pts')!.pointVertices!),
    ).toEqual(Array.from(packPoints([[20, 30, 0]])))
  })
})

describe('SourceManager.setSourceData — _reseedInPlace (#1371) variant staleness (#1800)', () => {
  it('#1800 red-today: demotes to the full teardown/rebuild path once a variant catalog exists', async () => {
    const { mgr, registered, order } = makeManager()
    await attachBase(mgr)
    registered.set(VARIANT_KEY, {
      source: new TileCatalog(),
      renderer: new StubVectorTileRenderer(),
    })

    mgr.setSourceData(SOURCE_ID, PATCHED_FC)

    // RED on pre-#1800 code: the `live && prevBackend` gate took `_reseedInPlace`
    // unconditionally, so NEITHER teardownSource NOR rebuildLayers ever ran —
    // `order` stayed `[]` — and VARIANT_KEY was never touched. This is the
    // line that is red pre-fix (actual: []).
    expect(
      order,
      '#1800 — a variant catalog must force the full teardown/rebuild path (only rebuildLayers() walks every variant)',
    ).toEqual(['teardown', 'rebuild'])
  })

  it('control: still takes the reseed-in-place fast path when no variant catalog exists', async () => {
    const { mgr, order, registered } = makeManager()
    await attachBase(mgr)

    mgr.setSourceData(SOURCE_ID, PATCHED_FC)

    expect(order).toEqual([])

    // #2439 — the fast path KEEPS the renderer, so the dense `categorical()`
    // value lists it derived describe the PREVIOUS data. Assert the re-seed is
    // forwarded with the NEW features: without it the next tile packs the new
    // data against the old ranks and every category shifts colour, silently.
    const stub = registered.get(SOURCE_ID)!.renderer
    expect(stub.setSeededFeatures).toHaveBeenCalledTimes(1)
    const seeded = stub.setSeededFeatures.mock.calls[0]![0] as unknown[]
    expect(seeded).toHaveLength(PATCHED_FC.features.length)
    // Ordering matters: seeding must happen BEFORE the tiles are re-requested,
    // or a tile can be packed against the stale lists it was meant to replace.
    expect(stub.setSeededFeatures.mock.invocationCallOrder[0]!).toBeLessThan(
      stub.reseedTiles.mock.invocationCallOrder[0]!,
    )
  })

  it('control: the pre-existing full-rebuild path (source never virtual-tiled) is unaffected', () => {
    const { mgr, rawDatasets, order } = makeManager()
    // No _vectorTile marker ⇒ setSourceData's fast-path gate is never reached
    // at all — this branch is untouched by the #1800 fix; pinned as the
    // already-correct control the issue asks for.
    rawDatasets.set(SOURCE_ID, {
      type: 'FeatureCollection',
      features: [],
    } as GeoJSONFeatureCollection)

    mgr.setSourceData(SOURCE_ID, PATCHED_FC)

    expect(order).toEqual(['teardown', 'rebuild'])
  })
})

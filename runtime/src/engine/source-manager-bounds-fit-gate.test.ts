import { describe, expect, it, vi } from 'vitest'

// B2: every source-attach path must route its post-attach camera-fit through
// `_runBoundsFitGate`, NOT just the per-attach `cameraFitState.fit` guard.
// Pre-fix the GeoJSON-URL branch (`_attachGeoJSONViaVirtualPMTiles`) — and
// the PMTiles branch in `_attachOneSource` — wrote the camera center/zoom
// whenever `cameraFitState.fit` was false, clobbering a camera the host had
// explicitly positioned (markCameraPositioned / setCenter / jumpTo / hash /
// pointer) the moment the source compile landed. The inline path was already
// correctly gated; the fix brings these two to parity.
//
// `_attachGeoJSONViaVirtualPMTiles` builds a VectorTileRenderer (needs a GPU
// device) and a VirtualPMTilesBackend (spawns the tiling Worker), neither of
// which exists in the node test environment. Mock both to inert stubs so the
// method runs to its camera-fit tail on CPU. The mock is behaviour-neutral:
// the VTR setters that run between construction and the camera-fit are no-ops
// regardless, and the GeoJSON path derives bounds from the data itself
// (computeGeoJSONBounds), not from the renderer.

vi.mock('./render/vector-tile-renderer', () => ({
  VectorTileRenderer: class {
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
    getBounds(): null { return null }
  },
}))

vi.mock('../data/sources/virtual-pmtiles-backend', () => ({
  // Inert TileSource — `attachBackend` reads `meta` (maxZoom / bounds /
  // scheme / layoutVersion) when merging into the catalog's index shell, so
  // supply a complete world-bounds meta. No worker is spawned.
  VirtualPMTilesBackend: class {
    meta = {
      bounds: [-180, -85, 180, 85] as [number, number, number, number],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz' as const,
      layoutVersion: 3,
    }
    has(): boolean { return false }
    attach(): void {}
    loadTile(): void {}
    detach(): void {}
  },
}))

import { SourceManager, type SourceManagerDeps } from './source-manager'
import { Camera } from './projection/camera'
import type { ShowSourceMaps } from './show-source-maps'
import type { GeoJSONFeatureCollection } from '../loader/geojson'
import type { MapRenderer } from './render/renderer'
import type { GPUContext } from './gpu/gpu'

/** A test double for XGISMap's `_runBoundsFitGate`: runs `apply` only when the
 *  camera has NOT been explicitly positioned — byte-identical logic to
 *  `XGISMap._runBoundsFitGate`. The `positioned` ref flips the way
 *  `markCameraPositioned()` / a programmatic setter would. */
function makeGate(positioned: { value: boolean }) {
  return (apply: () => void): boolean => {
    if (positioned.value) return false
    apply()
    return true
  }
}

/** Empty ShowSourceMaps — no per-source layer filter / extrude / stroke
 *  overrides; the attach reads these maps but a Paris polygon needs none. */
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

function makeSourceManager(camera: Camera, positioned: { value: boolean }) {
  // The mocked VectorTileRenderer ignores every value passed to its setters,
  // so a bare object satisfies the renderer-property reads in the attach.
  const rendererStub = {} as unknown as MapRenderer
  const deps: SourceManagerDeps = {
    rawDatasets: new Map(),
    vtSources: new Map(),
    sourceCRS: new Map(),
    geojsonCapPoles: new Map(),
    camera,
    canvas: { width: 1200, height: 800 } as unknown as HTMLCanvasElement,
    getCtx: () => ({ device: {}, format: 'bgra8unorm' }) as unknown as GPUContext,
    getRenderer: () => rendererStub,
    getLineRenderer: () => null,
    invalidate: () => {},
    // Linear stand-in distinct from the camera's starting zoom so a fit is
    // observable.
    fitZoomToLonSpan: () => 9,
    runBoundsFitGate: makeGate(positioned),
    rebuildLayers: () => {},
    teardownSource: () => {},
    deleteFeatureIndex: () => {},
  }
  return new SourceManager(deps)
}

// A small box around Paris — bounds-fit recenters here when the gate is open.
function parisFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[2.2, 48.8], [2.5, 48.8], [2.5, 48.9], [2.2, 48.9], [2.2, 48.8]]],
        },
        properties: {},
      },
    ],
  }
}

describe('SourceManager GeoJSON-URL attach honours the bounds-fit gate (B2)', () => {
  it('OPEN gate: attach fits the camera to the data bounds', async () => {
    const positioned = { value: false }
    const camera = new Camera(0, 0, 2)
    const startX = camera.centerX
    const startZoom = camera.zoom
    const sm = makeSourceManager(camera, positioned)

    await sm._attachGeoJSONViaVirtualPMTiles('paris', parisFC(), emptyMaps(), { fit: false })

    // Gate open → camera-fit ran → centre moved toward Paris (east of lon 0)
    // and zoom took the stand-in fit value.
    expect(camera.centerX).toBeGreaterThan(startX)
    expect(camera.zoom).toBe(9)
    expect(camera.zoom).not.toBe(startZoom)
  })

  it('CLOSED gate: an explicitly-positioned camera is NOT clobbered by the attach', async () => {
    const positioned = { value: true } // host called markCameraPositioned / a setter
    const camera = new Camera(0, 0, 2)
    const startX = camera.centerX
    const startY = camera.centerY
    const startZoom = camera.zoom
    const sm = makeSourceManager(camera, positioned)

    await sm._attachGeoJSONViaVirtualPMTiles('paris', parisFC(), emptyMaps(), { fit: false })

    // Gate closed → camera-fit suppressed → camera untouched. Pre-fix this
    // failed: the attach wrote centerX/zoom regardless of the gate.
    expect(camera.centerX).toBe(startX)
    expect(camera.centerY).toBe(startY)
    expect(camera.zoom).toBe(startZoom)
  })
})

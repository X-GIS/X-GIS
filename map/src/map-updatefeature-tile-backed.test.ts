// ═══ updateFeature() silent-drop on tile-backed sources ══════════════
//
// updateFeature() is a public API. GeoJSON URL sources (and any
// URL-loaded vector / raster source) default to a tile-backed backend
// which stores the synthetic marker `{_vectorTile:true}` / `{_tileUrl}`
// in rawDatasets — NOT a real FeatureCollection. The old precondition
// was only `rawDatasets.has(sourceId)` (TRUE for the marker), so the
// patch enqueued, the flush hit `!Array.isArray(data.features)` →
// `continue`, and the patch was discarded with NO warning. A documented
// public API silently no-op'd on the standard URL-loaded GeoJSON case.
//
// Fix: warn-once at enqueue time (host learns immediately) and return
// without queuing; plus a defensive warn-once at the flush `continue`.
// GPU-free: rawDatasets is public, so we seed the marker directly to
// mimic the VirtualPMTiles route without a real load.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { XGISMap } from './map'
import type { GeoJSONFeatureCollection } from '@xgis/data'

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

type MapInternals = {
  rawDatasets: Map<string, GeoJSONFeatureCollection>
  _pendingPatches: Map<string, Map<number, unknown>>
}

const tileBackedWarns = (warnSpy: MockInstance, sourceId: string) =>
  warnSpy.mock.calls.filter(
    (c) => String(c[0]).includes('updateFeature') && String(c[0]).includes(`"${sourceId}"`),
  )

describe('updateFeature: tile-backed source warns once instead of silent drop', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('warns once for a `{_vectorTile:true}` marker and does NOT enqueue the patch', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals
    // Mimic the VirtualPMTiles route (source-manager.ts:229).
    m.rawDatasets.set('vt', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    map.updateFeature('vt', 42, { properties: { highlighted: true } })

    expect(tileBackedWarns(warnSpy, 'vt')).toHaveLength(1)
    const msg = String(tileBackedWarns(warnSpy, 'vt')[0]![0])
    expect(msg).toContain('tile-backed')
    expect(msg).toContain('setSourceData')
    // The patch must NOT be queued (pre-fix: queued then dropped at flush).
    expect(m._pendingPatches.has('vt')).toBe(false)

    map.destroy()
  })

  it('warns once for a `{_tileUrl}` raster marker too', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals
    m.rawDatasets.set('raster', {
      _tileUrl: 'https://x/{z}/{x}/{y}.pbf',
    } as unknown as GeoJSONFeatureCollection)

    map.updateFeature('raster', 1, { properties: { a: 1 } })

    expect(tileBackedWarns(warnSpy, 'raster')).toHaveLength(1)
    expect(m._pendingPatches.has('raster')).toBe(false)
    map.destroy()
  })

  it('warns exactly ONCE per source — a second updateFeature on the same marker stays silent', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals
    m.rawDatasets.set('vt', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    map.updateFeature('vt', 1, { properties: { x: 1 } })
    map.updateFeature('vt', 2, { properties: { y: 2 } })
    map.updateFeature('vt', 1, { geometry: { type: 'Point', coordinates: [0, 0] } })

    expect(tileBackedWarns(warnSpy, 'vt')).toHaveLength(1)
    map.destroy()
  })

  it('happy path: a real FeatureCollection source does NOT warn and DOES enqueue the patch', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals
    // A host-pushed (setSourceData-style) real FeatureCollection.
    m.rawDatasets.set('geo', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 7,
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: {},
        },
      ],
    } as unknown as GeoJSONFeatureCollection)

    map.updateFeature('geo', 7, { properties: { highlighted: true } })

    // No tile-backed (or unknown-source) warning for a patchable source.
    expect(tileBackedWarns(warnSpy, 'geo')).toHaveLength(0)
    // The patch IS queued for the next flush (unchanged happy path).
    expect(m._pendingPatches.has('geo')).toBe(true)
    expect(m._pendingPatches.get('geo')!.has(7)).toBe(true)

    map.destroy()
  })

  it('still warns once for a genuinely unknown source (precondition unchanged)', () => {
    const map = new XGISMap(stubCanvas())
    map.updateFeature('nope', 1, { properties: {} })
    const unknownWarns = warnSpy.mock.calls.filter(
      (c) => String(c[0]).includes('updateFeature') && String(c[0]).includes('unknown source'),
    )
    expect(unknownWarns).toHaveLength(1)
    map.destroy()
  })

  // #1235 gap 2 — a virtual-tiled geojson source (marker in rawDatasets) whose
  // seeded FC the SourceManager kept IS patchable: the patch enqueues without
  // a warning, and the flush patches the seeded FC then re-seeds it through
  // setSourceData.
  it('#1235 gap 2: a marker source WITH a seeded FC accepts the patch and re-seeds', async () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals & {
      sourceManager: { hostSeededFC: Map<string, GeoJSONFeatureCollection> }
    }
    m.rawDatasets.set('vt', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)
    const seeded: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 5,
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { n: 'a' },
        },
      ],
    } as GeoJSONFeatureCollection
    m.sourceManager.hostSeededFC.set('vt', seeded)
    const reseedSpy = vi.spyOn(map, 'setSourceData').mockImplementation(() => {})

    map.updateFeature('vt', 5, { geometry: { type: 'Point', coordinates: [9, 9] } })

    expect(tileBackedWarns(warnSpy, 'vt')).toHaveLength(0)
    expect(m._pendingPatches.has('vt')).toBe(true)

    // Let the coalescing rAF/setTimeout flush fire.
    await new Promise((r) => setTimeout(r, 80))
    expect(reseedSpy).toHaveBeenCalledTimes(1)
    expect(reseedSpy.mock.calls[0]![0]).toBe('vt')
    const pushed = reseedSpy.mock.calls[0]![1] as GeoJSONFeatureCollection
    expect((pushed.features[0]!.geometry as { coordinates: number[] }).coordinates).toEqual([9, 9])

    reseedSpy.mockRestore()
    map.destroy()
  })

  it('#1235 gap 2: a declared-CRS marker source still warns (re-seed would double-reproject)', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals & {
      sourceManager: { hostSeededFC: Map<string, GeoJSONFeatureCollection> }
      sourceCRS: Map<string, string>
    }
    m.rawDatasets.set('crs', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)
    m.sourceManager.hostSeededFC.set('crs', {
      type: 'FeatureCollection',
      features: [],
    } as GeoJSONFeatureCollection)
    m.sourceCRS.set('crs', 'EPSG:5179')

    map.updateFeature('crs', 1, { properties: { x: 1 } })

    expect(tileBackedWarns(warnSpy, 'crs')).toHaveLength(1)
    expect(m._pendingPatches.has('crs')).toBe(false)
    map.destroy()
  })
})

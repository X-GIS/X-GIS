import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'
import type { GeoJSONFeatureCollection } from '../loader/geojson'

// ═══ Inline GeoJSON `data: {...}` source seeding (runtime) ═══
//
// A `source x { data: {...} }` block compiles to a LoadCommand carrying
// `inlineData`. The runtime ingest path (`SourceManager._attachOneSource`)
// routes that through `_seedInlineGeoJSON`, which seeds the same store a
// url-loaded geojson FC (and the programmatic / Mapbox-import inline FC)
// ends up in: `rawDatasets`. rebuildLayers renders fills / lines / points
// from rawDatasets, so every paint kind works on an inline-data source.
//
// Driving the `_seedInlineGeoJSON` seam directly is a GPU-free integration
// proof of the wiring (the full attach path / rebuildLayers needs a GPU
// device). Mirrors map-epsg-ingest-reprojection.test.ts's seam-test pattern.

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

function sourceManagerOf(map: XGISMap): { _seedInlineGeoJSON(name: string, fc: GeoJSONFeatureCollection): void } {
  return (map as unknown as { sourceManager: { _seedInlineGeoJSON(name: string, fc: GeoJSONFeatureCollection): void } }).sourceManager
}
function rawDatasetsOf(map: XGISMap): Map<string, GeoJSONFeatureCollection> {
  return (map as unknown as { rawDatasets: Map<string, GeoJSONFeatureCollection> }).rawDatasets
}

// The GOAL inline FC: a single Point feature (matches the feature spec).
function quakesFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [127, 37] },
        properties: { mag: 5.1 },
      },
    ],
  } as GeoJSONFeatureCollection
}

describe('XGISMap inline `data:` source seeding', () => {
  it('seeds rawDatasets with the inline FeatureCollection', () => {
    const map = new XGISMap(mockCanvas())
    const fc = quakesFC()

    sourceManagerOf(map)._seedInlineGeoJSON('quakes', fc)

    const seeded = rawDatasetsOf(map).get('quakes')
    expect(seeded).toBeDefined()
    expect(seeded!.type).toBe('FeatureCollection')
    expect(seeded!.features).toHaveLength(1)
    // No declared CRS ⇒ EPSG:4326 / no-op reproject ⇒ coords unchanged.
    expect((seeded!.features[0]!.geometry as { coordinates: number[] }).coordinates).toEqual([127, 37])
    expect(seeded!.features[0]!.properties).toEqual({ mag: 5.1 })
  })

  it('seeds a polygon-only inline FC into rawDatasets', () => {
    const map = new XGISMap(mockCanvas())
    const polyFC: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
          properties: {},
        },
      ],
    } as GeoJSONFeatureCollection

    sourceManagerOf(map)._seedInlineGeoJSON('land', polyFC)

    const seeded = rawDatasetsOf(map).get('land')
    expect(seeded).toBeDefined()
    expect(seeded!.features).toHaveLength(1)
    expect(seeded!.features[0]!.geometry!.type).toBe('Polygon')
  })

  it('drops a non-FeatureCollection inline payload without throwing', () => {
    const map = new XGISMap(mockCanvas())
    // A bad payload (no `features` array) must not pollute rawDatasets.
    sourceManagerOf(map)._seedInlineGeoJSON('bad', { type: 'FeatureCollection' } as unknown as GeoJSONFeatureCollection)
    expect(rawDatasetsOf(map).has('bad')).toBe(false)
  })
})

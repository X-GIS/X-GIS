// MVT (.pbf) tile decoder. Reads a single Mapbox Vector Tile and emits
// GeoJSONFeature[] with un-quantized lon/lat, ready to feed into the
// existing decomposeFeatures → compileSingleTile pipeline.
//
// MVT geometry coordinates are tile-local integers in [0, extent]. The
// upstream toGeoJSON(x,y,z) call un-quantizes via Web Mercator, which
// matches our tile addressing.
//
// Multi-layer MVTs (most real datasets — "water", "roads", "buildings")
// flatten to one feature array; the originating layer name is stashed
// in properties._layer so style code can filter on it.
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import type { GeoJSONFeature, GeoJSONGeometry } from '../tiler/geojson-types'

export interface MvtDecodeOptions {
  /** Restrict to a subset of layer names. Omit for all layers. */
  layers?: string[]
}

export function decodeMvtTile(
  buf: ArrayBuffer | Uint8Array,
  z: number,
  x: number,
  y: number,
  opts: MvtDecodeOptions = {},
): GeoJSONFeature[] {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const tile = new VectorTile(new Pbf(bytes))
  const layerFilter = opts.layers ? new Set(opts.layers) : null
  const out: GeoJSONFeature[] = []

  for (const layerName of Object.keys(tile.layers)) {
    if (layerFilter && !layerFilter.has(layerName)) continue
    const layer = tile.layers[layerName]
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      const gj = f.toGeoJSON(x, y, z)
      if (!gj.geometry) continue
      out.push({
        type: 'Feature',
        geometry: gj.geometry as GeoJSONGeometry,
        properties: {
          ...(gj.properties ?? {}),
          _layer: layerName,
        },
      })
    }
  }
  return out
}

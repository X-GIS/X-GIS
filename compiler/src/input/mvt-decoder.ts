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
      // Clamp coordinates to the planet — MVT's "buffer" feature
      // lets polygons extend slightly beyond tile bounds (default
      // 64 px past each edge), and vector-tile-js's toGeoJSON
      // un-quantizes those buffer vertices to lon/lat values that
      // can fall outside [-180, 180] / [-85, 85] for tiles near the
      // antimeridian or poles. Downstream Mercator projection then
      // produces points outside the planet's MM range, and after
      // tile-rect clipping the polygon shape is corrupted into
      // long horizontal slivers (visible as horizontal stripes
      // crossing oceans at low z). Clamp here so all vertices land
      // inside the planet's lon/lat range.
      const clampedGeom = clampGeometryToPlanet(gj.geometry as GeoJSONGeometry)
      out.push({
        type: 'Feature',
        geometry: clampedGeom,
        properties: {
          ...(gj.properties ?? {}),
          _layer: layerName,
        },
      })
    }
  }
  return out
}

const LON_MAX = 180
const LON_MIN = -180
const LAT_MAX = 85.0511287
const LAT_MIN = -85.0511287
const clampLon = (v: number) => v > LON_MAX ? LON_MAX : v < LON_MIN ? LON_MIN : v
const clampLat = (v: number) => v > LAT_MAX ? LAT_MAX : v < LAT_MIN ? LAT_MIN : v

function clampPos(p: number[]): number[] {
  return [clampLon(p[0]), clampLat(p[1])]
}

function clampGeometryToPlanet(g: GeoJSONGeometry): GeoJSONGeometry {
  switch (g.type) {
    case 'Point':       return { type: 'Point', coordinates: clampPos(g.coordinates) }
    case 'MultiPoint':  return { type: 'MultiPoint', coordinates: g.coordinates.map(clampPos) }
    case 'LineString':  return { type: 'LineString', coordinates: g.coordinates.map(clampPos) }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: g.coordinates.map(ls => ls.map(clampPos)) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: g.coordinates.map(ring => ring.map(clampPos)) }
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: g.coordinates.map(poly => poly.map(ring => ring.map(clampPos))) }
  }
}

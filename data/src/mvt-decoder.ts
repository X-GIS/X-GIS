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
import type { GeoJSONFeature, GeoJSONGeometry } from '@xgis/compiler'

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
      // #2511 — one quantisation unit of THIS tile: a point further than that
      // beyond ±180° is geojsonvt's antimeridian wrap copy, not noise.
      const lonUnit = 360 / (layer.extent * Math.pow(2, z))
      const clampedGeom = clampGeometryToPlanet(gj.geometry as GeoJSONGeometry, lonUnit)
      if (!clampedGeom) continue
      out.push({
        type: 'Feature',
        // #1375 — MVT Feature tag 1 (`id`). `GeoJSONFeature.id` is documented
        // as "MVT decoders populate this from the feature.id field of the .mvt
        // protobuf" (compiler/src/tiler/geojson-types.ts) and this decoder was
        // the one that did not: `["id"]` / `$featureId` read null on every
        // MVT-backed source, and a host-pushed feature lost its stable
        // identity the moment it was tiled. Stays `undefined` when the tile
        // carries no id, so "no id" and "id 0" remain distinguishable.
        id: f.id,
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
// iter-296 — `v > MAX` and `v < MIN` are both false for NaN, so the
// previous ternary returned NaN unchanged on a malformed-MVT decode
// path. Surfaced by iter-296 fuzz. Same defensive convention as
// evaluator's `toNumber`: non-finite → 0 (planet centre). Real-world
// reach: tiny (the external decoder is well-formed-tested), but the
// downstream renderer reads these as f32 vertex positions where NaN
// poisons the whole tile mesh.
// NaN guard only — Infinity vs MAX/MIN compares correctly already
// (Infinity > MAX = true → MAX). Pre-fix the NaN branch leaked NaN
// through both comparisons (NaN > MAX and NaN < MIN both false →
// fallthrough returned NaN). Surfaced by iter-296 fuzz.
const clampLon = (v: number) =>
  Number.isNaN(v) ? 0 : v > LON_MAX ? LON_MAX : v < LON_MIN ? LON_MIN : v
const clampLat = (v: number) =>
  Number.isNaN(v) ? 0 : v > LAT_MAX ? LAT_MAX : v < LAT_MIN ? LAT_MIN : v

function clampPos(p: number[]): number[] {
  return [clampLon(p[0]), clampLat(p[1])]
}

// #1221 R4 — LINE-only clamp: latitude ONLY, longitude untouched. The
// antimeridian buffer/wrap copy geojsonvt emits (geojsonvt/wrap.ts) lands at
// lon just BEYOND ±180 by design — the renderer draws those west-buffer
// vertices at world-copy +1 so a seam-crossing LineString continues across the
// antimeridian. clampLon collapsed that whole beyond-±180 run onto EXACTLY
// ±180, degenerating it into a vertical wall of segments on the seam that the
// line renderer drew as a spurious vertical stroke (only visible when the
// camera looks at ±180, since that is where world-copy +1 lands it). Leaving
// lon unclamped lets compileSingleTile's per-tile rect clip drop the
// out-of-world portion cleanly (no wall) while keeping the in-world
// continuation. Latitude still clamps (the ±85 pole-sliver fix is unaffected —
// its Mercator magnitude, not a seam wrap, is the corruption source). Polygon /
// point arms keep the full clampPos (the original horizontal-sliver fix).
//
// The iter-296 non-finite guard stays: a malformed MVT (e.g. extent 0 → 0/0 in
// toGeoJSON's un-quantisation) can emit NaN/±Infinity lon, and the downstream
// Liang-Barsky clip fails OPEN on non-finite input (q/p → NaN passes every
// edge test), leaking NaN vertices into the f32 tile mesh. Only the RANGE
// clamp is dropped — wrap-copy longitudes are always finite.
function clampPosLatOnly(p: number[]): number[] {
  return [Number.isFinite(p[0]) ? p[0] : 0, clampLat(p[1])]
}

// #2511 — POINT arm: a point beyond ±180° by more than one quantisation unit is
// the antimeridian wrap copy geojsonvt emits into the tile's buffer (the same
// beyond-±180 run the line arm keeps unclamped, #1221 R4). Clamping it onto the
// seam drew a PHANTOM marker at exactly lon ±180 for every point within the
// tiler's buffer of the world edge (lon 100 / 127 / 170 at z0), in every world
// copy, on Mercator, the discs and the globe alike. The neighbouring world's
// copy of the point is drawn by the world-copy loop, so the wrap copy is
// DROPPED. Within one unit (a point ON the antimeridian, un-quantised to
// 180.0x) it is noise: clamp as before. Returns null when nothing survives.
function planetPoint(p: number[], lonUnit: number): number[] | null {
  return Math.abs(p[0]!) > 180 + lonUnit ? null : clampPos(p)
}

function clampGeometryToPlanet(g: GeoJSONGeometry, lonUnit: number): GeoJSONGeometry | null {
  switch (g.type) {
    case 'Point': {
      const c = planetPoint(g.coordinates, lonUnit)
      return c ? { type: 'Point', coordinates: c } : null
    }
    case 'MultiPoint': {
      const cs = g.coordinates.map((p) => planetPoint(p, lonUnit)).filter((c) => c !== null)
      return cs.length > 0 ? { type: 'MultiPoint', coordinates: cs } : null
    }
    case 'LineString':
      return { type: 'LineString', coordinates: g.coordinates.map(clampPosLatOnly) }
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: g.coordinates.map((ls) => ls.map(clampPosLatOnly)),
      }
    case 'Polygon':
      return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(clampPos)) }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: g.coordinates.map((poly) => poly.map((ring) => ring.map(clampPos))),
      }
    // MVT never encodes GeometryCollection (spec has no GC geometry type),
    // but the union arm exists (RFC 7946 §3.1.8) — clamp members recursively
    // so the function stays total over its declared domain.
    case 'GeometryCollection': {
      const gs = g.geometries
        .map((m) => clampGeometryToPlanet(m, lonUnit))
        .filter((m) => m !== null)
      return gs.length > 0 ? { type: 'GeometryCollection', geometries: gs } : null
    }
  }
}

// 1:1 port of geojson-vt/src/tile.js — builds an internal tile by
// running each projected feature through simplification (Douglas-
// Peucker importance values were stamped at convert time) and emits
// flat 2-coordinate per-vertex output (no z importance after this).

import type {
  FlatLine,
  GeoJSONVTOptions,
  InternalTile,
  ProjectedFeature,
  TileFeature,
  TileGeometryType,
} from './types'

// #360 F2 — world zooms render at FULL FIDELITY (no Douglas-Peucker
// simplification). At z<=3 the per-zoom tolerance below is large enough to
// straighten the world-ocean ring's narrow inlets (Gibraltar→Mediterranean,
// Black Sea, Caspian, Guinea coast) and the sub-85° Arctic — the ring chord
// cuts across the inlet mouth, dropping the enclosed sea, which then renders
// clear/BLACK (an oracle data-faithfulness violation; confirmed real-GPU +
// raw point-in-polygon + tolerance bisect, 2026-06-15). The vertex-count cost
// at world zoom is trivial (single-digit-thousands worldwide); z>=4 keep the
// zoom-scaled tolerance (byte-identical), maxZoom was already 0. This is an
// intentional divergence from upstream geojson-vt at low zoom.
const LOW_ZOOM_NO_SIMPLIFY = 3

// #460 — full-fidelity at low zoom (tolerance 0, the #360 F2 fix above) is only
// affordable when the tile is cheap. A detailed source (the 14 MB picking-demo
// countries.geojson ≈ 548k verts) otherwise drops ~3.45M tris into the single
// z0 world tile → ~5 s compile → the fill + picking are blank for seconds. Cap
// it: keep full fidelity at low zoom only while the tile's input vertex count is
// under budget; past it, fall back to the normal zoom-scaled tolerance (coarse
// world borders — correct at world scale, matches MapLibre). The shipped ocean
// ring (ne_110m_ocean ≈ 5.3k verts, and finer oceans well under this) stays
// under budget, so the #360 enclosed-sea coverage at z0-3 is untouched.
const LOW_ZOOM_FULL_FIDELITY_BUDGET = 100_000

/** Cheap input-vertex count (sums FlatLine lengths; O(rings), not O(coords)). */
function countPoints(geom: FlatLine | FlatLine[] | FlatLine[][]): number {
  if (geom.length === 0) return 0
  if (typeof geom[0] === 'number') return (geom as FlatLine).length / 3
  let n = 0
  for (const part of geom as Array<FlatLine | FlatLine[]>) n += countPoints(part)
  return n
}

export function createTile(
  features: ProjectedFeature[],
  z: number,
  tx: number,
  ty: number,
  options: GeoJSONVTOptions,
): InternalTile {
  // Low-zoom full fidelity only while under the vertex budget (#460/#360).
  let lowZoomFidelity = z <= LOW_ZOOM_NO_SIMPLIFY
  if (lowZoomFidelity && z !== options.maxZoom) {
    let pts = 0
    for (const f of features) {
      pts += countPoints(f.geometry)
      if (pts > LOW_ZOOM_FULL_FIDELITY_BUDGET) {
        lowZoomFidelity = false
        break
      }
    }
  }
  const tolerance =
    z === options.maxZoom || lowZoomFidelity ? 0 : options.tolerance / ((1 << z) * options.extent)
  const tile: InternalTile = {
    features: [],
    numPoints: 0,
    numSimplified: 0,
    numFeatures: features.length,
    source: null,
    x: tx,
    y: ty,
    z,
    transformed: false,
    minX: 2,
    minY: 1,
    maxX: -1,
    maxY: 0,
  }
  for (const feature of features) {
    addFeature(tile, feature, tolerance)
  }
  return tile
}

function addFeature(tile: InternalTile, feature: ProjectedFeature, tolerance: number): void {
  const geom = feature.geometry
  const type = feature.type
  const simplified: FlatLine | FlatLine[] = []

  tile.minX = Math.min(tile.minX, feature.minX)
  tile.minY = Math.min(tile.minY, feature.minY)
  tile.maxX = Math.max(tile.maxX, feature.maxX)
  tile.maxY = Math.max(tile.maxY, feature.maxY)

  if (type === 'Point' || type === 'MultiPoint') {
    const flat = geom as FlatLine
    for (let i = 0; i < flat.length; i += 3) {
      ;(simplified as FlatLine).push(flat[i], flat[i + 1])
      tile.numPoints++
      tile.numSimplified++
    }
  } else if (type === 'LineString') {
    addLine(simplified as FlatLine, geom as FlatLine, tile, tolerance, false, false)
  } else if (type === 'MultiLineString' || type === 'Polygon') {
    const rings = geom as FlatLine[]
    for (let i = 0; i < rings.length; i++) {
      addLine(simplified as FlatLine[], rings[i], tile, tolerance, type === 'Polygon', i === 0)
    }
  } else if (type === 'MultiPolygon') {
    const polys = geom as FlatLine[][]
    for (let k = 0; k < polys.length; k++) {
      const polygon = polys[k]
      for (let i = 0; i < polygon.length; i++) {
        addLine(simplified as FlatLine[], polygon[i], tile, tolerance, true, i === 0)
      }
    }
  }

  const len = (simplified as unknown as { length: number }).length
  if (len) {
    const tags = feature.tags ?? null

    const tileFeature: TileFeature = {
      geometry: simplified as FlatLine | FlatLine[],
      type: (type === 'Polygon' || type === 'MultiPolygon'
        ? 3
        : type === 'LineString' || type === 'MultiLineString'
          ? 2
          : 1) as TileGeometryType,
      tags,
    }
    if (feature.id !== null) {
      tileFeature.id = feature.id as string | number
    }
    tile.features.push(tileFeature)
  }
}

function addLine(
  result: FlatLine | FlatLine[],
  geom: FlatLine,
  tile: InternalTile,
  tolerance: number,
  isPolygon: boolean,
  isOuter: boolean,
): void {
  const sqTolerance = tolerance * tolerance

  if (tolerance > 0 && (geom.size ?? 0) < (isPolygon ? sqTolerance : tolerance)) {
    tile.numPoints += geom.length / 3
    return
  }

  const ring: FlatLine = []

  for (let i = 0; i < geom.length; i += 3) {
    if (tolerance === 0 || geom[i + 2] > sqTolerance) {
      tile.numSimplified++
      ring.push(geom[i], geom[i + 1])
    }
    tile.numPoints++
  }

  if (isPolygon) rewind(ring, isOuter)

  ;(result as FlatLine[]).push(ring)
}

function rewind(ring: FlatLine, clockwise: boolean): void {
  let area = 0
  for (let i = 0, len = ring.length, j = len - 2; i < len; j = i, i += 2) {
    area += (ring[i] - ring[j]) * (ring[i + 1] + ring[j + 1])
  }
  if (area > 0 === clockwise) {
    for (let i = 0, len = ring.length; i < len / 2; i += 2) {
      const x = ring[i]
      const y = ring[i + 1]
      ring[i] = ring[len - 2 - i]
      ring[i + 1] = ring[len - 1 - i]
      ring[len - 2 - i] = x
      ring[len - 1 - i] = y
    }
  }
}

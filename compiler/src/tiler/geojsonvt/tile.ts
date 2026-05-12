// 1:1 port of geojson-vt/src/tile.js — builds an internal tile by
// running each projected feature through simplification (Douglas-
// Peucker importance values were stamped at convert time) and emits
// flat 2-coordinate per-vertex output (no z importance after this).

import type {
  FlatLine, GeoJSONVTOptions, InternalTile, ProjectedFeature, TileFeature, TileGeometryType,
} from './types'

export function createTile(
  features: ProjectedFeature[],
  z: number,
  tx: number,
  ty: number,
  options: GeoJSONVTOptions,
): InternalTile {
  const tolerance = z === options.maxZoom ? 0 : options.tolerance / ((1 << z) * options.extent)
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
    addFeature(tile, feature, tolerance, options)
  }
  return tile
}

function addFeature(
  tile: InternalTile,
  feature: ProjectedFeature,
  tolerance: number,
  options: GeoJSONVTOptions,
): void {
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
      (simplified as FlatLine).push(flat[i], flat[i + 1])
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
    let tags = feature.tags ?? null

    if (type === 'LineString' && options.lineMetrics) {
      const g = geom as FlatLine
      tags = {}
      for (const key in feature.tags) tags[key] = feature.tags[key]
      tags['mapbox_clip_start'] = (g.start ?? 0) / (g.size ?? 1)
      tags['mapbox_clip_end'] = (g.end ?? 0) / (g.size ?? 1)
    }

    const tileFeature: TileFeature = {
      geometry: simplified as FlatLine | FlatLine[],
      type: (type === 'Polygon' || type === 'MultiPolygon' ? 3 :
        (type === 'LineString' || type === 'MultiLineString' ? 2 : 1)) as TileGeometryType,
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

  if (tolerance > 0 && ((geom.size ?? 0) < (isPolygon ? sqTolerance : tolerance))) {
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

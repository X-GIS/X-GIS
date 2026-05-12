// 1:1 port of geojson-vt/src/convert.js — GeoJSON FeatureCollection →
// projected intermediate format. Project lat/lon to [0, 1] unit
// square (Web Mercator), stamp simplification importance on each
// vertex, push closed polygon rings to FlatLine[].

import { simplify } from './simplify'
import { createFeature } from './feature'
import type {
  GeoJSONInput, GeoJSONVTOptions, FlatLine, ProjectedFeature,
} from './types'

export function convert(
  data: GeoJSONInput,
  options: GeoJSONVTOptions,
): ProjectedFeature[] {
  const features: ProjectedFeature[] = []
  if (data.type === 'FeatureCollection') {
    const feats = data.features ?? []
    for (let i = 0; i < feats.length; i++) {
      convertFeature(features, feats[i] as unknown as GeoJSONInput, options, i)
    }
  } else if (data.type === 'Feature') {
    convertFeature(features, data, options)
  } else {
    // Single geometry or a geometry collection
    convertFeature(features, { geometry: data as unknown as GeoJSONInput['geometry'] } as GeoJSONInput, options)
  }

  return features
}

function convertFeature(
  features: ProjectedFeature[],
  geojson: GeoJSONInput,
  options: GeoJSONVTOptions,
  index?: number,
): void {
  if (!geojson.geometry) return

  const coords = (geojson.geometry as { coordinates: unknown }).coordinates as unknown
  if (Array.isArray(coords) && coords.length === 0) return

  const type = (geojson.geometry as { type: string }).type as ProjectedFeature['type']
  const tolerance = Math.pow(options.tolerance / ((1 << options.maxZoom) * options.extent), 2)
  let geometry: FlatLine | FlatLine[] | FlatLine[][] = []
  let id = geojson.id
  if (options.promoteId !== null) {
    id = geojson.properties?.[options.promoteId] as string | number
  } else if (options.generateId) {
    id = index ?? 0
  }
  if (type === 'Point') {
    convertPoint(coords as number[], geometry as FlatLine)
  } else if (type === 'MultiPoint') {
    for (const p of coords as number[][]) {
      convertPoint(p, geometry as FlatLine)
    }
  } else if (type === 'LineString') {
    convertLine(coords as number[][], geometry as FlatLine, tolerance, false)
  } else if (type === 'MultiLineString') {
    convertLines(coords as number[][][], geometry as FlatLine[], tolerance, false)
  } else if (type === 'Polygon') {
    convertLines(coords as number[][][], geometry as FlatLine[], tolerance, true)
  } else if (type === 'MultiPolygon') {
    for (const polygon of coords as number[][][][]) {
      const newPolygon: FlatLine[] = []
      convertLines(polygon, newPolygon, tolerance, true)
      ;(geometry as FlatLine[][]).push(newPolygon)
    }
  } else if (type as string === 'GeometryCollection') {
    const geometries = (geojson.geometry as { geometries?: unknown[] }).geometries ?? []
    for (const singleGeometry of geometries) {
      convertFeature(features, {
        id,
        geometry: singleGeometry as GeoJSONInput['geometry'],
        properties: geojson.properties,
      } as GeoJSONInput, options, index)
    }
    return
  } else {
    throw new Error('Input data is not a valid GeoJSON object.')
  }

  features.push(createFeature(id ?? null, type, geometry, geojson.properties ?? null))
}

function convertPoint(coords: number[], out: FlatLine): void {
  out.push(projectX(coords[0]), projectY(coords[1]), 0)
}

function convertLine(
  ring: number[][],
  out: FlatLine,
  tolerance: number,
  isPolygon: boolean,
): void {
  let x0 = 0, y0 = 0
  let size = 0

  for (let j = 0; j < ring.length; j++) {
    const x = projectX(ring[j][0])
    const y = projectY(ring[j][1])

    out.push(x, y, 0)

    if (j > 0) {
      if (isPolygon) {
        size += (x0 * y - x * y0) / 2 // signed area accumulator
      } else {
        size += Math.sqrt(Math.pow(x - x0, 2) + Math.pow(y - y0, 2)) // length
      }
    }
    x0 = x
    y0 = y
  }

  const last = out.length - 3
  out[2] = 1
  simplify(out, 0, last, tolerance)
  out[last + 2] = 1

  out.size = Math.abs(size)
  out.start = 0
  out.end = out.size
}

function convertLines(
  rings: number[][][],
  out: FlatLine[],
  tolerance: number,
  isPolygon: boolean,
): void {
  for (let i = 0; i < rings.length; i++) {
    const geom: FlatLine = []
    convertLine(rings[i], geom, tolerance, isPolygon)
    out.push(geom)
  }
}

function projectX(x: number): number {
  return x / 360 + 0.5
}

function projectY(y: number): number {
  const sin = Math.sin(y * Math.PI / 180)
  const y2 = 0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI
  return y2 < 0 ? 0 : y2 > 1 ? 1 : y2
}

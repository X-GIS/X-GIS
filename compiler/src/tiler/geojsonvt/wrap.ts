// 1:1 port of geojson-vt/src/wrap.js — wraps features around the
// antimeridian. Clips out the left and right "world buffer" copies,
// shifts them into the center tile's coordinate space, and merges.

import { clip } from './clip'
import { createFeature } from './feature'
import type {
  FlatLine, GeoJSONVTOptions, ProjectedFeature,
} from './types'

export function wrap(
  features: ProjectedFeature[],
  options: GeoJSONVTOptions,
): ProjectedFeature[] {
  const buffer = options.buffer / options.extent
  let merged: ProjectedFeature[] = features
  const left = clip(features, 1, -1 - buffer, buffer, 0, -1, 2)
  const right = clip(features, 1, 1 - buffer, 2 + buffer, 0, -1, 2)

  if (left || right) {
    merged = clip(features, 1, -buffer, 1 + buffer, 0, -1, 2) ?? []
    if (left) merged = shiftFeatureCoords(left, 1).concat(merged)
    if (right) merged = merged.concat(shiftFeatureCoords(right, -1))
  }

  return merged
}

function shiftFeatureCoords(
  features: ProjectedFeature[],
  offset: number,
): ProjectedFeature[] {
  const newFeatures: ProjectedFeature[] = []

  for (const feature of features) {
    const type = feature.type
    let newGeometry: FlatLine | FlatLine[] | FlatLine[][]

    if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
      newGeometry = shiftCoords(feature.geometry as FlatLine, offset)
    } else if (type === 'MultiLineString' || type === 'Polygon') {
      newGeometry = []
      for (const line of feature.geometry as FlatLine[]) {
        ;(newGeometry as FlatLine[]).push(shiftCoords(line, offset))
      }
    } else if (type === 'MultiPolygon') {
      newGeometry = []
      for (const polygon of feature.geometry as FlatLine[][]) {
        const newPolygon: FlatLine[] = []
        for (const line of polygon) {
          newPolygon.push(shiftCoords(line, offset))
        }
        ;(newGeometry as FlatLine[][]).push(newPolygon)
      }
    } else {
      newGeometry = []
    }

    newFeatures.push(createFeature(feature.id, type, newGeometry, feature.tags))
  }

  return newFeatures
}

function shiftCoords(points: FlatLine, offset: number): FlatLine {
  const newPoints: FlatLine = []
  newPoints.size = points.size

  if (points.start !== undefined) {
    newPoints.start = points.start
    newPoints.end = points.end
  }

  for (let i = 0; i < points.length; i += 3) {
    newPoints.push(points[i] + offset, points[i + 1], points[i + 2])
  }
  return newPoints
}

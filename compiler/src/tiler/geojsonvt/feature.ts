// 1:1 port of geojson-vt/src/feature.js — createFeature with bbox calc.

import type { FlatLine, InputGeometryType, ProjectedFeature } from './types'

export function createFeature(
  id: string | number | null | undefined,
  type: InputGeometryType,
  geom: FlatLine | FlatLine[] | FlatLine[][],
  tags: Record<string, unknown> | null,
): ProjectedFeature {
  const feature: ProjectedFeature = {
    id: id == null ? null : id,
    type,
    geometry: geom,
    tags,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }

  if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
    calcLineBBox(feature, geom as FlatLine)
  } else if (type === 'Polygon') {
    // The outer ring (ie [0]) contains all inner rings — bbox computed from it alone.
    calcLineBBox(feature, (geom as FlatLine[])[0])
  } else if (type === 'MultiLineString') {
    for (const line of geom as FlatLine[]) {
      calcLineBBox(feature, line)
    }
  } else if (type === 'MultiPolygon') {
    for (const polygon of geom as FlatLine[][]) {
      calcLineBBox(feature, polygon[0])
    }
  }

  return feature
}

function calcLineBBox(feature: ProjectedFeature, geom: FlatLine): void {
  for (let i = 0; i < geom.length; i += 3) {
    feature.minX = Math.min(feature.minX, geom[i])
    feature.minY = Math.min(feature.minY, geom[i + 1])
    feature.maxX = Math.max(feature.maxX, geom[i])
    feature.maxY = Math.max(feature.maxY, geom[i + 1])
  }
}

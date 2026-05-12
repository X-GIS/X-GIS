// 1:1 port of geojson-vt/src/clip.js — clips features between two
// axis-parallel lines:
//
//      |         |
//   ___|___      |       /
//  /   |   \_____|______/
//      |         |
//
// k1 and k2 are the line coordinates; axis = 0 (x) or 1 (y).
// minAll/maxAll are the all-feature aggregate bounds on the axis,
// used for trivial accept/reject without iterating features.

import { createFeature } from './feature'
import type {
  FlatLine, GeoJSONVTOptions, ProjectedFeature,
} from './types'

export function clip(
  features: ProjectedFeature[],
  scale: number,
  k1: number,
  k2: number,
  axis: 0 | 1,
  minAll: number,
  maxAll: number,
  options: GeoJSONVTOptions,
): ProjectedFeature[] | null {
  k1 /= scale
  k2 /= scale

  if (minAll >= k1 && maxAll < k2) return features // trivial accept
  if (maxAll < k1 || minAll >= k2) return null    // trivial reject

  const clipped: ProjectedFeature[] = []

  for (const feature of features) {
    const geometry = feature.geometry
    let type = feature.type

    const min = axis === 0 ? feature.minX : feature.minY
    const max = axis === 0 ? feature.maxX : feature.maxY

    if (min >= k1 && max < k2) { // trivial accept
      clipped.push(feature)
      continue
    } else if (max < k1 || min >= k2) { // trivial reject
      continue
    }

    let newGeometry: FlatLine | FlatLine[] | FlatLine[][] = []

    if (type === 'Point' || type === 'MultiPoint') {
      clipPoints(geometry as FlatLine, newGeometry as FlatLine, k1, k2, axis)
    } else if (type === 'LineString') {
      clipLine(geometry as FlatLine, newGeometry as FlatLine[], k1, k2, axis, false, options.lineMetrics)
    } else if (type === 'MultiLineString') {
      clipLines(geometry as FlatLine[], newGeometry as FlatLine[], k1, k2, axis, false)
    } else if (type === 'Polygon') {
      clipLines(geometry as FlatLine[], newGeometry as FlatLine[], k1, k2, axis, true)
    } else if (type === 'MultiPolygon') {
      for (const polygon of geometry as FlatLine[][]) {
        const newPolygon: FlatLine[] = []
        clipLines(polygon, newPolygon, k1, k2, axis, true)
        if (newPolygon.length) {
          ;(newGeometry as FlatLine[][]).push(newPolygon)
        }
      }
    }

    const lenAfter = (newGeometry as unknown as { length: number }).length
    if (lenAfter) {
      if (options.lineMetrics && type === 'LineString') {
        for (const line of newGeometry as FlatLine[]) {
          clipped.push(createFeature(feature.id, type, line, feature.tags))
        }
        continue
      }

      if (type === 'LineString' || type === 'MultiLineString') {
        if ((newGeometry as FlatLine[]).length === 1) {
          type = 'LineString'
          newGeometry = (newGeometry as FlatLine[])[0]
        } else {
          type = 'MultiLineString'
        }
      }
      if (type === 'Point' || type === 'MultiPoint') {
        type = (newGeometry as FlatLine).length === 3 ? 'Point' : 'MultiPoint'
      }

      clipped.push(createFeature(feature.id, type, newGeometry, feature.tags))
    }
  }

  return clipped.length ? clipped : null
}

function clipPoints(
  geom: FlatLine,
  newGeom: FlatLine,
  k1: number,
  k2: number,
  axis: 0 | 1,
): void {
  for (let i = 0; i < geom.length; i += 3) {
    const a = geom[i + axis]
    if (a >= k1 && a <= k2) {
      addPoint(newGeom, geom[i], geom[i + 1], geom[i + 2])
    }
  }
}

function clipLine(
  geom: FlatLine,
  newGeom: FlatLine[],
  k1: number,
  k2: number,
  axis: 0 | 1,
  isPolygon: boolean,
  trackMetrics: boolean,
): void {
  let slice = newSlice(geom)
  const intersect = axis === 0 ? intersectX : intersectY
  let len = geom.start ?? 0
  let segLen = 0
  let t = 0

  for (let i = 0; i < geom.length - 3; i += 3) {
    const ax = geom[i]
    const ay = geom[i + 1]
    const az = geom[i + 2]
    const bx = geom[i + 3]
    const by = geom[i + 4]
    const a = axis === 0 ? ax : ay
    const b = axis === 0 ? bx : by
    let exited = false

    if (trackMetrics) segLen = Math.sqrt(Math.pow(ax - bx, 2) + Math.pow(ay - by, 2))

    if (a < k1) {
      // ---|-->  | (line enters the clip region from below k1)
      if (b > k1) {
        t = intersect(slice, ax, ay, bx, by, k1)
        if (trackMetrics) slice.start = len + segLen * t
      }
    } else if (a > k2) {
      // |  <--|--- (line enters the clip region from above k2)
      if (b < k2) {
        t = intersect(slice, ax, ay, bx, by, k2)
        if (trackMetrics) slice.start = len + segLen * t
      }
    } else {
      addPoint(slice, ax, ay, az)
    }
    if (b < k1 && a >= k1) {
      // <--|---  | or <--|-----|--- (line exits the clip region below k1)
      t = intersect(slice, ax, ay, bx, by, k1)
      exited = true
    }
    if (b > k2 && a <= k2) {
      // |  ---|--> or ---|-----|--> (line exits the clip region above k2)
      t = intersect(slice, ax, ay, bx, by, k2)
      exited = true
    }

    if (!isPolygon && exited) {
      if (trackMetrics) slice.end = len + segLen * t
      newGeom.push(slice)
      slice = newSlice(geom)
    }

    if (trackMetrics) len += segLen
  }

  // Add the last point
  let last = geom.length - 3
  const ax = geom[last]
  const ay = geom[last + 1]
  const az = geom[last + 2]
  const a = axis === 0 ? ax : ay
  if (a >= k1 && a <= k2) addPoint(slice, ax, ay, az)

  // Close the polygon if its endpoints aren't the same after clipping
  last = slice.length - 3
  if (isPolygon && last >= 3 && (slice[last] !== slice[0] || slice[last + 1] !== slice[1])) {
    addPoint(slice, slice[0], slice[1], slice[2])
  }

  // Add the final slice
  if (slice.length) {
    newGeom.push(slice)
  }
}

function newSlice(line: FlatLine): FlatLine {
  const slice: FlatLine = []
  slice.size = line.size
  slice.start = line.start
  slice.end = line.end
  return slice
}

function clipLines(
  geom: FlatLine[],
  newGeom: FlatLine[],
  k1: number,
  k2: number,
  axis: 0 | 1,
  isPolygon: boolean,
): void {
  for (const line of geom) {
    clipLine(line, newGeom, k1, k2, axis, isPolygon, false)
  }
}

function addPoint(out: FlatLine, x: number, y: number, z: number): void {
  out.push(x, y, z)
}

function intersectX(
  out: FlatLine,
  ax: number, ay: number,
  bx: number, by: number,
  x: number,
): number {
  const t = (x - ax) / (bx - ax)
  addPoint(out, x, ay + (by - ay) * t, 1)
  return t
}

function intersectY(
  out: FlatLine,
  ax: number, ay: number,
  bx: number, by: number,
  y: number,
): number {
  const t = (y - ay) / (by - ay)
  addPoint(out, ax + (bx - ax) * t, y, 1)
  return t
}

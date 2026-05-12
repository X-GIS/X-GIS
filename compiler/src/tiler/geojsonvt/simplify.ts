// 1:1 port of geojson-vt/src/simplify.js — Douglas-Peucker, writes
// per-vertex importance (squared distance from segment) into the
// `z` slot of each coordinate triple. Recursion replaces only
// vertices whose importance exceeds sqTolerance at later filter
// time; here we just stamp the metadata.

import type { FlatLine } from './types'

export function simplify(
  coords: FlatLine,
  first: number,
  last: number,
  sqTolerance: number,
): void {
  let maxSqDist = sqTolerance
  const mid = first + ((last - first) >> 1)
  let minPosToMid = last - first
  let index: number | undefined

  const ax = coords[first]
  const ay = coords[first + 1]
  const bx = coords[last]
  const by = coords[last + 1]

  for (let i = first + 3; i < last; i += 3) {
    const d = getSqSegDist(coords[i], coords[i + 1], ax, ay, bx, by)

    if (d > maxSqDist) {
      index = i
      maxSqDist = d
    } else if (d === maxSqDist) {
      // Stability workaround for degenerate inputs — see
      // github.com/mapbox/geojson-vt/issues/104. Picking a pivot near
      // the middle of the candidate range keeps recursion depth bounded.
      const posToMid = Math.abs(i - mid)
      if (posToMid < minPosToMid) {
        index = i
        minPosToMid = posToMid
      }
    }
  }

  if (maxSqDist > sqTolerance && index !== undefined) {
    if (index - first > 3) simplify(coords, first, index, sqTolerance)
    coords[index + 2] = maxSqDist
    if (last - index > 3) simplify(coords, index, last, sqTolerance)
  }
}

function getSqSegDist(
  px: number, py: number,
  x: number, y: number,
  bx: number, by: number,
): number {
  let dx = bx - x
  let dy = by - y

  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy)

    if (t > 1) {
      x = bx
      y = by
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }

  dx = px - x
  dy = py - y

  return dx * dx + dy * dy
}

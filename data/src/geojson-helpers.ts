// Pure free functions extracted from geojson.ts.
//
// lonLatToMercator is re-exported from geojson.ts to preserve every prior
// import path (camera, source-manager, etc.). The subdivision / anti-meridian
// clipping helpers (subdivideRing, splitWidePolygon, splitLineAtAntiMeridian,
// …) are internal helpers consumed by the loader module. Every function here
// is pure: no `this`, no module-level state, no side effects beyond the value
// it returns. The shared subdivision constants live here too, since both these
// helpers and the tessellation functions in geojson.ts key off them.

import { interpolateGreatCircle } from '@xgis/compiler/tiler/geodesic'

// ═══ Projection helpers (CPU side, for bounds only) ═══

// lonLatToMercator's single authority now lives in @xgis/engine (projection.ts);
// re-exported here so every prior import path (camera, source-manager, geojson.ts)
// keeps resolving. Relocated in P3 Step 3 to sever the camera→loader content edge.
export { lonLatToMercator } from '@xgis/engine'

// ═══ Subdivision ═══
// 큰 삼각형을 세분화하여 프로젝션 곡선을 근사

export const MAX_EDGE_DEGREES = 3 // 링 변 세분화 기준
export const MAX_TRI_DEGREES = 2  // 삼각형 세분화 기준 (이보다 큰 변이 있으면 4분할)

/** Subdivide a ring by inserting midpoints along long edges.
 *  Falls back to linear interpolation when lon exceeds ±180° (antimeridian
 *  shift), since great circle slerp normalizes lon to ±180. */
export function subdivideRing(ring: number[][]): number[][] {
  const result: number[][] = []

  for (let i = 0; i < ring.length; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % ring.length]
    result.push(curr)

    const dlon = Math.abs(next[0] - curr[0])
    const dlat = Math.abs(next[1] - curr[1])
    const maxDeg = Math.max(dlon, dlat)

    if (maxDeg > MAX_EDGE_DEGREES) {
      // Use linear interpolation when coordinates are in shifted antimeridian
      // space (lon > 180 or < -180), since great circle slerp wraps lon.
      const useLinear = curr[0] > 180 || curr[0] < -180 || next[0] > 180 || next[0] < -180
      const segments = Math.ceil(maxDeg / MAX_EDGE_DEGREES)
      for (let s = 1; s < segments; s++) {
        const t = s / segments
        if (useLinear) {
          result.push([curr[0] + (next[0] - curr[0]) * t, curr[1] + (next[1] - curr[1]) * t])
        } else {
          result.push(interpolateGreatCircle(curr[0], curr[1], next[0], next[1], t))
        }
      }
    }
  }

  return result
}

// ═══ Anti-meridian handling ═══
// 날짜변경선(180°)을 넘는 폴리곤을 Sutherland-Hodgman 클리핑으로 분할
// 절대 좌표 공간에서 earcut하면 내부 삼각형 변이 지구를 횡단 → 반드시 분할 필요

/** Detect if a ring crosses the anti-meridian (±180°) */
function detectsAntiMeridianCross(ring: number[][]): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) return true
  }
  // World-wrapping polygons (Antarctica spans -180° to +180°)
  let minLon = Infinity, maxLon = -Infinity
  for (const [lon] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  return maxLon - minLon > 350
}

/** Clip a ring at a cut line using Sutherland-Hodgman algorithm.
 *  axis: 0 = longitude (x), 1 = latitude (y) */
function clipRingAtLine(ring: number[][], cutVal: number, keepLess: boolean, axis: 0 | 1): number[][] {
  const result: number[][] = []
  const n = ring.length
  const len = ring[n - 1][0] === ring[0][0] && ring[n - 1][1] === ring[0][1] ? n - 1 : n

  for (let i = 0; i < len; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % len]
    const currIn = keepLess ? curr[axis] <= cutVal : curr[axis] >= cutVal
    const nextIn = keepLess ? next[axis] <= cutVal : next[axis] >= cutVal

    if (currIn) {
      result.push(curr)
      if (!nextIn) {
        const t = (cutVal - curr[axis]) / (next[axis] - curr[axis])
        if (axis === 0) result.push([cutVal, curr[1] + t * (next[1] - curr[1])])
        else result.push([curr[0] + t * (next[0] - curr[0]), cutVal])
      }
    } else if (nextIn) {
      const t = (cutVal - curr[axis]) / (next[axis] - curr[axis])
      if (axis === 0) result.push([cutVal, curr[1] + t * (next[1] - curr[1])])
      else result.push([curr[0] + t * (next[0] - curr[0]), cutVal])
    }
  }

  if (result.length > 0) {
    const first = result[0], last = result[result.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      result.push([first[0], first[1]])
    }
  }
  return result
}

// @ts-expect-error: reserved for future meridian splitting
function _clipRingAtLon(ring: number[][], cutLon: number, keepLess: boolean): number[][] {
  return clipRingAtLine(ring, cutLon, keepLess, 0)
}

/** Max longitude span for a single tessellated piece (prevents globe-spanning earcut edges) */
const MAX_PIECE_WIDTH = 20

/** Clip a set of rings (outer + holes) at a line, returning low/high halves */
function clipRingsAtLine(rings: number[][][], cutVal: number, axis: 0 | 1): { low: number[][][] | null, high: number[][][] | null } {
  const lowOuter = clipRingAtLine(rings[0], cutVal, true, axis)
  const highOuter = clipRingAtLine(rings[0], cutVal, false, axis)

  const buildPart = (outer: number[][], keepLess: boolean): number[][][] | null => {
    if (outer.length < 4) return null
    const holes: number[][][] = []
    for (let r = 1; r < rings.length; r++) {
      const clipped = clipRingAtLine(rings[r], cutVal, keepLess, axis)
      if (clipped.length >= 4) holes.push(clipped)
    }
    return [outer, ...holes]
  }

  return { low: buildPart(lowOuter, true), high: buildPart(highOuter, false) }
}

function clipRingsAtLon(rings: number[][][], cutLon: number): { west: number[][][] | null, east: number[][][] | null } {
  const { low, high } = clipRingsAtLine(rings, cutLon, 0)
  return { west: low, east: high }
}

/**
 * Split polygon rings to keep each piece ≤ MAX_PIECE_WIDTH° wide.
 * Handles anti-meridian crossing + large polygons (Russia spans 152°).
 * Returns array of ring-sets, each tessellated independently.
 */
export function splitWidePolygon(rings: number[][][]): number[][][][] {
  let processedRings = rings

  // Step 1: Anti-meridian — shift to continuous coordinate space
  if (detectsAntiMeridianCross(rings[0])) {
    const shift = (ring: number[][]): number[][] =>
      ring.map(([lon, lat]) => lon < -90 ? [lon + 360, lat] : [lon, lat])
    processedRings = rings.map(shift)
  }

  // Step 2: Determine extent
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of processedRings[0]) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  const lonSpan = maxLon - minLon
  const latSpan = maxLat - minLat
  if (lonSpan <= MAX_PIECE_WIDTH && latSpan <= MAX_PIECE_WIDTH) return [processedRings]

  // Step 3: First split at 180° (anti-meridian boundary) so no piece straddles it
  // Then shift east pieces back to [-180, 0] before further splitting
  let westParts: number[][][][] = []
  let eastParts: number[][][][] = []

  if (minLon < 180 && maxLon > 180) {
    const { west, east } = clipRingsAtLon(processedRings, 180)
    if (west) westParts.push(west)
    if (east) {
      // Shift east coordinates back to standard range
      const shifted = east.map(ring =>
        ring.map(([lon, lat]) => [lon - 360, lat])
      )
      eastParts.push(shifted)
    }
  } else if (maxLon > 180) {
    // Entirely east of 180° — shift back
    eastParts.push(processedRings.map(ring =>
      ring.map(([lon, lat]) => [lon - 360, lat])
    ))
  } else {
    westParts.push(processedRings)
  }

  // Step 4: Split at MAX_PIECE_WIDTH intervals on both lon and lat axes
  const splitOnAxis = (parts: number[][][][], axis: 0 | 1): number[][][][] => {
    const result: number[][][][] = []
    for (const partRings of parts) {
      let pMin = Infinity, pMax = -Infinity
      for (const coord of partRings[0]) {
        const v = coord[axis]
        if (v < pMin) pMin = v
        if (v > pMax) pMax = v
      }
      if (pMax - pMin <= MAX_PIECE_WIDTH) {
        result.push(partRings)
        continue
      }

      const cutVals: number[] = []
      const start = Math.ceil(pMin / MAX_PIECE_WIDTH) * MAX_PIECE_WIDTH
      for (let v = start; v < pMax; v += MAX_PIECE_WIDTH) {
        if (v > pMin) cutVals.push(v)
      }

      let subParts: number[][][][] = [partRings]
      for (const cutVal of cutVals) {
        const newSub: number[][][][] = []
        for (const sub of subParts) {
          const { low, high } = clipRingsAtLine(sub, cutVal, axis)
          if (low) newSub.push(low)
          if (high) newSub.push(high)
        }
        subParts = newSub
      }
      result.push(...subParts)
    }
    return result
  }

  // Split by longitude, then by latitude
  westParts = splitOnAxis(splitOnAxis(westParts, 0), 1)
  eastParts = splitOnAxis(splitOnAxis(eastParts, 0), 1)

  return [...westParts, ...eastParts]
}

/** Split a linestring at every anti-meridian crossing (|Δlon| > 180°).
 *  Returns one or more continuous coordinate arrays. */
export function splitLineAtAntiMeridian(coords: number[][]): number[][][] {
  if (coords.length < 2) return [coords]

  let needsSplit = false
  for (let i = 0; i < coords.length - 1; i++) {
    if (Math.abs(coords[i + 1][0] - coords[i][0]) > 180) { needsSplit = true; break }
  }
  if (!needsSplit) return [coords]

  const pieces: number[][][] = []
  let current: number[][] = [coords[0]]

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1]
    const dlon = b[0] - a[0]

    if (Math.abs(dlon) > 180) {
      // Crosses anti-meridian — compute the crossing latitude.
      // Shift b to continuous space, find t where lon = ±180.
      const bShifted = dlon > 0 ? b[0] - 360 : b[0] + 360
      const cutLon = dlon > 0 ? -180 : 180
      const t = (cutLon - a[0]) / (bShifted - a[0])
      const cutLat = a[1] + t * (b[1] - a[1])

      // End current piece at the crossing
      current.push([cutLon, cutLat])
      pieces.push(current)

      // Start new piece from the opposite side of the meridian
      current = [[-cutLon, cutLat], b]
    } else {
      current.push(b)
    }
  }

  if (current.length >= 2) pieces.push(current)
  return pieces
}

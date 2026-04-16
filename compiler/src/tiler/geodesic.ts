// ═══ Great Circle (Geodesic) Interpolation ═══
// Spherical linear interpolation (slerp) on the unit sphere for computing
// intermediate points along the shortest path between two coordinates.

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const EARTH_R = 6378137

/**
 * Interpolate a point along the great circle arc between two coordinates.
 * Uses spherical slerp — accurate for navigation-scale distances, ignores
 * Earth's ellipsoidal flattening (max error ~0.3% vs WGS84 ellipsoid).
 *
 * @param t  Interpolation parameter [0, 1]. 0 = start, 1 = end.
 * @returns  [lon, lat] in degrees.
 */
export function interpolateGreatCircle(
  lon1: number, lat1: number,
  lon2: number, lat2: number,
  t: number,
): [number, number] {
  const φ1 = lat1 * DEG2RAD, λ1 = lon1 * DEG2RAD
  const φ2 = lat2 * DEG2RAD, λ2 = lon2 * DEG2RAD

  // Central angle via Haversine (numerically stable for small distances)
  const sinDφ = Math.sin((φ2 - φ1) / 2)
  const sinDλ = Math.sin((λ2 - λ1) / 2)
  const d = 2 * Math.asin(Math.sqrt(sinDφ * sinDφ + Math.cos(φ1) * Math.cos(φ2) * sinDλ * sinDλ))

  // Near-coincident points: fall back to linear
  if (d < 1e-12) return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]

  // Slerp weights
  const sinD = Math.sin(d)
  const a = Math.sin((1 - t) * d) / sinD
  const b = Math.sin(t * d) / sinD

  // Cartesian interpolation on unit sphere
  const cosφ1 = Math.cos(φ1), cosφ2 = Math.cos(φ2)
  const x = a * cosφ1 * Math.cos(λ1) + b * cosφ2 * Math.cos(λ2)
  const y = a * cosφ1 * Math.sin(λ1) + b * cosφ2 * Math.sin(λ2)
  const z = a * Math.sin(φ1) + b * Math.sin(φ2)

  return [Math.atan2(y, x) * RAD2DEG, Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG]
}

/**
 * Great-circle distance between two points in meters (Haversine formula).
 */
export function haversineDistance(
  lon1: number, lat1: number,
  lon2: number, lat2: number,
): number {
  const φ1 = lat1 * DEG2RAD, φ2 = lat2 * DEG2RAD
  const sinDφ = Math.sin((φ2 - φ1) / 2)
  const sinDλ = Math.sin((lon2 - lon1) * DEG2RAD / 2)
  const a = sinDφ * sinDφ + Math.cos(φ1) * Math.cos(φ2) * sinDλ * sinDλ
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

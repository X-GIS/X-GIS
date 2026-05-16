// ═══ Map Projections ═══
// WGS84 (lon, lat) → 평면 좌표 (x, y)

const EARTH_RADIUS = 6378137
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

// Canonical Web Mercator latitude limit (degrees). EPSG:3857 clips at the
// latitude whose tangent maps to π in the projected plane: atan(sinh(π)) ≈
// 85.051128779807°. Use this value everywhere on the CPU side — splitting
// clamps across 85.05 / 85.051 / 85.051129 as this repo did causes
// sub-km Y drift between tile selection and rendering at polar latitudes.
export const MERCATOR_LAT_LIMIT = 85.051129

export interface Projection {
  name: string
  forward(lon: number, lat: number): [number, number]
  inverse(x: number, y: number): [number, number]
}

// ═══ Web Mercator (EPSG:3857) ═══
// 현재 기본값. 웹 지도 표준.

export const mercator: Projection = {
  name: 'mercator',

  forward(lon: number, lat: number): [number, number] {
    const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
    const x = lon * DEG2RAD * EARTH_RADIUS
    const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG2RAD) / 2)) * EARTH_RADIUS
    return [x, y]
  },

  inverse(x: number, y: number): [number, number] {
    const lon = (x / EARTH_RADIUS) * RAD2DEG
    const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * RAD2DEG
    return [lon, lat]
  },
}

// Longitude delta wrapped to [-180, 180]. Identity inside that range so
// the pure (central-meridian = 0) definitions are byte-unchanged; only
// the recentred (camera-longitude) case shifts. The GPU shader
// (shaders/projection.ts `wrap_lon_delta`) and projection-wgsl-mirror.ts
// (`wrapLonDelta`) use the IDENTICAL formula so CPU tile-bounds / the
// Canvas2D fallback agree with GPU rendering at any central meridian.
export function wrapLonDelta(d: number): number {
  if (d > 180) return d - 360 * Math.ceil((d - 180) / 360)
  if (d < -180) return d + 360 * Math.ceil((-d - 180) / 360)
  return d
}

// ═══ Equirectangular (Plate Carrée, EPSG:4326) ═══
// 가장 단순. 경위도를 직접 x, y로.
//
// Pseudocylindrical → fixed central parallel (equator). Interactive use
// recentres the central MERIDIAN on the camera longitude (D3
// `.rotate([-λ, 0])` convention) so the viewed region sits where
// distortion is minimal instead of being sheared at the world-oval edge.
// `centralLon = 0` reproduces textbook Plate Carrée.

export function equirectangular(centralLon = 0): Projection {
  return {
    name: 'equirectangular',

    forward(lon: number, lat: number): [number, number] {
      const x = wrapLonDelta(lon - centralLon) * DEG2RAD * EARTH_RADIUS
      const y = lat * DEG2RAD * EARTH_RADIUS
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      const lon = wrapLonDelta((x / EARTH_RADIUS) * RAD2DEG + centralLon)
      const lat = (y / EARTH_RADIUS) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Natural Earth ═══
// Šavrič et al. (2015) 6th-order polynomial. Matches the WGSL
// proj_natural_earth in wgsl-projection.ts exactly so CPU tile-bounds
// math and GPU rendering agree. See projection-wgsl-consistency.test.ts.
//
// History: The previous implementation was Patterson's 13-entry table
// (y = NE_B × π × R). It produced y values up to 2× the polynomial's —
// a ~8145 km drift near the poles. Surfaced by the Phase 2-A cross-
// consistency test on 2026-04-20. No internal callers depended on the
// old output; external users were getting a "Natural Earth I"-shaped
// map on CPU while the GPU rendered "Natural Earth II". Unified here.

//
// Pseudocylindrical, like equirectangular: fixed central parallel,
// interactive central-meridian recentre on `centralLon` (longitude-only
// — a latitude rotation would be a non-standard oblique aspect).
// `centralLon = 0` reproduces the textbook Šavrič et al. (2015) form.
export function naturalEarth(centralLon = 0): Projection {
  return {
    name: 'natural_earth',

    forward(lon: number, lat: number): [number, number] {
      const latR = lat * DEG2RAD
      const lat2 = latR * latR
      const lat4 = lat2 * lat2
      const lat6 = lat2 * lat4
      const xScale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6
      const yVal = latR * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)))
      return [wrapLonDelta(lon - centralLon) * DEG2RAD * xScale * EARTH_RADIUS, yVal * EARTH_RADIUS]
    },

    inverse(x: number, y: number): [number, number] {
      // Newton-Raphson on the latitude polynomial, 5 iterations. Mirrors
      // reprojector.ts inv_natural_earth.
      const goalY = y / EARTH_RADIUS
      let t = goalY / 1.007226
      for (let i = 0; i < 5; i++) {
        const t2 = t * t
        const t4 = t2 * t2
        const t6 = t2 * t4
        const t8 = t4 * t4
        const yVal = t * (1.007226 + t2 * (0.015085 + t2 * (-0.044475 + 0.028874 * t2 - 0.005916 * t4)))
        const f = yVal - goalY
        const dy = 1.007226 + 0.045255 * t2 - 0.222375 * t4 + 0.202118 * t6 - 0.053244 * t8
        if (Math.abs(dy) < 1e-10) break
        t = t - f / dy
      }
      const t2 = t * t
      const t4 = t2 * t2
      const t6 = t2 * t4
      const xScale = 0.8707 - 0.131979 * t2 + 0.013791 * t4 - 0.0081435 * t6
      if (Math.abs(xScale) < 1e-6) return [NaN, NaN]
      const lon = wrapLonDelta((x / (xScale * EARTH_RADIUS)) * RAD2DEG + centralLon)
      const lat = t * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Orthographic (지구 사진처럼 보이는 투영) ═══

export function orthographic(centerLon: number, centerLat: number): Projection {
  const lam0 = centerLon * DEG2RAD
  const phi0 = centerLat * DEG2RAD
  const sinPhi0 = Math.sin(phi0)
  const cosPhi0 = Math.cos(phi0)

  return {
    name: 'orthographic',

    forward(lon: number, lat: number): [number, number] {
      const lam = lon * DEG2RAD
      const phi = lat * DEG2RAD
      const cosC = sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(lam - lam0)

      // Back-face culling: point on far side of globe
      if (cosC < 0) return [NaN, NaN]

      const x = EARTH_RADIUS * Math.cos(phi) * Math.sin(lam - lam0)
      const y = EARTH_RADIUS * (cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(lam - lam0))
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      const rho = Math.sqrt(x * x + y * y)
      // At the projection centre rho→0 makes the lat/lon terms divide by
      // zero (0/0 → NaN). azimuthalEquidistant/stereographic.inverse and
      // reprojector.ts inv_orthographic all guard this; mirror them.
      if (rho < 0.001) return [centerLon, centerLat]
      if (rho > EARTH_RADIUS) return [NaN, NaN]
      const c = Math.asin(rho / EARTH_RADIUS)
      const cosC = Math.cos(c)
      const sinC = Math.sin(c)
      const lat = Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / rho) * RAD2DEG
      const lon = (lam0 + Math.atan2(x * sinC, rho * cosPhi0 * cosC - y * sinPhi0 * sinC)) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Azimuthal Equidistant ═══

export function azimuthalEquidistant(centerLon: number, centerLat: number): Projection {
  const lam0 = centerLon * DEG2RAD
  const phi0 = centerLat * DEG2RAD
  const sinPhi0 = Math.sin(phi0)
  const cosPhi0 = Math.cos(phi0)

  return {
    name: 'azimuthal_equidistant',

    forward(lon: number, lat: number): [number, number] {
      const lam = lon * DEG2RAD
      const phi = lat * DEG2RAD
      const cosC = sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(lam - lam0)
      const c = Math.acos(Math.max(-1, Math.min(1, cosC)))
      if (c < 0.0001) return [0, 0]
      const k = c / Math.sin(c)
      const x = EARTH_RADIUS * k * Math.cos(phi) * Math.sin(lam - lam0)
      const y = EARTH_RADIUS * k * (cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(lam - lam0))
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      const rho = Math.sqrt(x * x + y * y)
      if (rho < 0.001) return [centerLon, centerLat]
      const c = rho / EARTH_RADIUS
      const cosC = Math.cos(c)
      const sinC = Math.sin(c)
      const lat = Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / rho) * RAD2DEG
      const lon = (lam0 + Math.atan2(x * sinC, rho * cosPhi0 * cosC - y * sinPhi0 * sinC)) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Stereographic ═══

export function stereographic(centerLon: number, centerLat: number): Projection {
  const lam0 = centerLon * DEG2RAD
  const phi0 = centerLat * DEG2RAD
  const sinPhi0 = Math.sin(phi0)
  const cosPhi0 = Math.cos(phi0)

  return {
    name: 'stereographic',

    forward(lon: number, lat: number): [number, number] {
      const lam = lon * DEG2RAD
      const phi = lat * DEG2RAD
      const cosC = sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(lam - lam0)
      if (cosC < -0.9) return [NaN, NaN]
      const k = 2.0 / (1.0 + cosC)
      const x = EARTH_RADIUS * k * Math.cos(phi) * Math.sin(lam - lam0)
      const y = EARTH_RADIUS * k * (cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(lam - lam0))
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      const rho = Math.sqrt(x * x + y * y)
      if (rho < 0.001) return [centerLon, centerLat]
      const c = 2 * Math.atan2(rho, 2 * EARTH_RADIUS)
      const cosC = Math.cos(c)
      const sinC = Math.sin(c)
      const lat = Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / rho) * RAD2DEG
      const lon = (lam0 + Math.atan2(x * sinC, rho * cosPhi0 * cosC - y * sinPhi0 * sinC)) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Oblique Mercator ═══

export function obliqueMercator(centerLon: number, centerLat: number): Projection {
  const lam0 = centerLon * DEG2RAD
  const phi0 = centerLat * DEG2RAD
  const sinPhi0 = Math.sin(phi0)
  const cosPhi0 = Math.cos(phi0)

  return {
    name: 'oblique_mercator',

    forward(lon: number, lat: number): [number, number] {
      const lam = lon * DEG2RAD
      const phi = lat * DEG2RAD
      const dLam = lam - lam0
      // Rotated latitude: tilt sphere so (centerLon, centerLat) sits on the equator.
      const phiRot = Math.asin(Math.max(-1, Math.min(1,
        Math.sin(phi) * cosPhi0 - Math.cos(phi) * sinPhi0 * Math.cos(dLam),
      )))
      // Rotated longitude in same frame.
      const lamRot = Math.atan2(
        Math.cos(phi) * Math.sin(dLam),
        Math.sin(phi) * sinPhi0 + Math.cos(phi) * cosPhi0 * Math.cos(dLam),
      )
      const MERCATOR_LIMIT_RAD = MERCATOR_LAT_LIMIT * DEG2RAD
      const phiClamped = Math.max(-MERCATOR_LIMIT_RAD, Math.min(MERCATOR_LIMIT_RAD, phiRot))
      const x = EARTH_RADIUS * lamRot
      const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phiClamped / 2))
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      // Inverse Mercator on rotated frame, then unrotate (rotate by -clat
      // around the same axis).
      const phiRot = 2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2
      const lamRot = x / EARTH_RADIUS
      const lat = Math.asin(Math.max(-1, Math.min(1,
        Math.sin(phiRot) * cosPhi0 + Math.cos(phiRot) * Math.cos(lamRot) * sinPhi0,
      ))) * RAD2DEG
      const lon = (lam0 + Math.atan2(
        Math.cos(phiRot) * Math.sin(lamRot),
        -Math.sin(phiRot) * sinPhi0 + Math.cos(phiRot) * Math.cos(lamRot) * cosPhi0,
      )) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Projection Registry ═══

const PROJECTIONS: Record<string, Projection | ((...args: number[]) => Projection)> = {
  mercator,
  equirectangular: (lon = 0) => equirectangular(lon),
  natural_earth: (lon = 0) => naturalEarth(lon),
  orthographic: (lon = 0, lat = 20) => orthographic(lon, lat),
  azimuthal_equidistant: (lon = 0, lat = 20) => azimuthalEquidistant(lon, lat),
  stereographic: (lon = 0, lat = 20) => stereographic(lon, lat),
  oblique_mercator: (lon = 0, lat = 20) => obliqueMercator(lon, lat),
}

export function getProjection(name: string, ...args: number[]): Projection {
  const proj = PROJECTIONS[name]
  if (!proj) {
    throw new Error(`Unknown projection: ${name}. Available: ${Object.keys(PROJECTIONS).join(', ')}`)
  }
  if (typeof proj === 'function') {
    return proj(...args)
  }
  return proj
}

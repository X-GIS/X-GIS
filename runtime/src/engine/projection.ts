// ═══ Map Projections ═══
// WGS84 (lon, lat) → 평면 좌표 (x, y)

const EARTH_RADIUS = 6378137
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

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
    const clampedLat = Math.max(-85.05, Math.min(85.05, lat))
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

// ═══ Equirectangular (Plate Carrée, EPSG:4326) ═══
// 가장 단순. 경위도를 직접 x, y로.

export const equirectangular: Projection = {
  name: 'equirectangular',

  forward(lon: number, lat: number): [number, number] {
    const x = lon * DEG2RAD * EARTH_RADIUS
    const y = lat * DEG2RAD * EARTH_RADIUS
    return [x, y]
  },

  inverse(x: number, y: number): [number, number] {
    const lon = (x / EARTH_RADIUS) * RAD2DEG
    const lat = (y / EARTH_RADIUS) * RAD2DEG
    return [lon, lat]
  },
}

// ═══ Natural Earth ═══
// 미적으로 균형 잡힌 의사원통 도법. 세계 지도에 적합.
// Robinson과 비슷하지만 수학적으로 더 깔끔.

const NE_A = [
  0.8707, 0.8707, 0.8680, 0.8620, 0.8530, 0.8400,
  0.8220, 0.7986, 0.7688, 0.7326, 0.6898, 0.6400, 0.5826,
]
const NE_B = [
  0.0000, 0.0940, 0.1880, 0.2810, 0.3720, 0.4600,
  0.5445, 0.6240, 0.6970, 0.7620, 0.8170, 0.8600, 0.8940,
]

function naturalEarthInterpolate(lat: number): [number, number] {
  const absLat = Math.abs(lat)
  const idx = Math.min(Math.floor(absLat / 7.5), 11)
  const frac = (absLat - idx * 7.5) / 7.5

  const a = NE_A[idx] + (NE_A[idx + 1] - NE_A[idx]) * frac
  const b = NE_B[idx] + (NE_B[idx + 1] - NE_B[idx]) * frac

  return [a, lat >= 0 ? b : -b]
}

export const naturalEarth: Projection = {
  name: 'natural_earth',

  forward(lon: number, lat: number): [number, number] {
    const [a, b] = naturalEarthInterpolate(lat)
    const x = lon * DEG2RAD * a * EARTH_RADIUS
    const y = b * Math.PI * EARTH_RADIUS
    return [x, y]
  },

  inverse(x: number, y: number): [number, number] {
    // Approximate inverse via iteration
    let lat = (y / (Math.PI * EARTH_RADIUS)) * 90
    for (let i = 0; i < 5; i++) {
      const [, b] = naturalEarthInterpolate(lat)
      const targetB = y / (Math.PI * EARTH_RADIUS)
      lat += (targetB - b) * 90
    }
    const [a] = naturalEarthInterpolate(lat)
    const lon = (x / (a * EARTH_RADIUS)) * RAD2DEG
    return [lon, lat]
  },
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
      const lamRot = Math.atan2(
        Math.cos(phi) * Math.sin(dLam),
        cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(dLam),
      )
      const phiRot = Math.asin(Math.max(-1, Math.min(1,
        sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(dLam),
      )))
      const phiShifted = Math.max(-1.5, Math.min(1.5, phiRot - Math.PI / 2))
      const x = EARTH_RADIUS * lamRot
      const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phiShifted / 2))
      return [x, y]
    },

    inverse(x: number, y: number): [number, number] {
      const phiShifted = 2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2
      const phiRot = phiShifted + Math.PI / 2
      const lamRot = x / EARTH_RADIUS
      const lat = Math.asin(Math.max(-1, Math.min(1,
        sinPhi0 * Math.sin(phiRot) + cosPhi0 * Math.cos(phiRot) * Math.cos(lamRot),
      ))) * RAD2DEG
      const lon = (lam0 + Math.atan2(
        Math.cos(phiRot) * Math.sin(lamRot),
        sinPhi0 * Math.cos(phiRot) * Math.cos(lamRot) - cosPhi0 * Math.sin(phiRot),
      )) * RAD2DEG
      return [lon, lat]
    },
  }
}

// ═══ Projection Registry ═══

const PROJECTIONS: Record<string, Projection | ((...args: number[]) => Projection)> = {
  mercator,
  equirectangular,
  natural_earth: naturalEarth,
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

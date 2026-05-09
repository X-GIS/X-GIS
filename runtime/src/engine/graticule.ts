// ═══ Graticule (위경도 그리드 라인) + Globe Background ═══
// GPU 프로젝션과 함께 동작. 줌 적응형 간격 + 메이저/마이너 구분.

export interface GraticuleData {
  /** Line segments in DSFUN stride 6:
   *  [mx_h, my_h, mx_l, my_l, feat_id, arc_start]. Graticules live in the
   *  "no-tile" frame so the Mercator-meter values are absolute (tile origin
   *  = (0,0) in the vs_main uniform). feat_id: 1 = major, 0 = minor. */
  vertices: Float32Array
  indexCount: number
}

const GRAT_EARTH_R = 6378137
const GRAT_DEG2RAD = Math.PI / 180
const GRAT_LAT_LIMIT = 85.051129

function lonLatToMercDSFUN(lon: number, lat: number, featId: number, out: number[]): void {
  const clampedLat = Math.max(-GRAT_LAT_LIMIT, Math.min(GRAT_LAT_LIMIT, lat))
  const mx = lon * GRAT_DEG2RAD * GRAT_EARTH_R
  const my = Math.log(Math.tan(Math.PI / 4 + clampedLat * GRAT_DEG2RAD / 2)) * GRAT_EARTH_R
  const mxH = Math.fround(mx)
  const mxL = Math.fround(mx - mxH)
  const myH = Math.fround(my)
  const myL = Math.fround(my - myH)
  out.push(mxH, myH, mxL, myL, featId, 0)
}

/** Determine major/minor grid spacing based on zoom level */
function stepsForZoom(zoom: number): { major: number; minor: number | null } {
  if (zoom < 3)  return { major: 30, minor: null }
  if (zoom < 5)  return { major: 15, minor: null }
  if (zoom < 7)  return { major: 10, minor: 5 }
  if (zoom < 9)  return { major: 5,  minor: 1 }
  return { major: 1, minor: 0.5 }
}

/** Per-zoom-bucket cache. `stepsForZoom` returns a discrete bucket
 *  (5 distinct values for the supported zoom range), so the
 *  graticule geometry is identical across all zoom levels in the same
 *  bucket. Without the cache, every Math.round(zoom) tick during a
 *  zoom animation re-ran the full grid generation (~130 k coordinate
 *  conversions + Float32Array allocation), and the bucket-changing
 *  frames ALIGN with LOD-tile-cascade frames — compounding the worst-
 *  frame hitch the interactive perf spec measured.
 *
 *  Cache key derived from the (major, minor) step pair, not zoom
 *  itself, so requests at different zooms in the same bucket share
 *  the same cached geometry. */
const graticuleCache = new Map<string, GraticuleData>()

/** Generate graticule grid lines for a given zoom level. Cached by
 *  zoom bucket — repeat calls within the same bucket return the same
 *  GraticuleData instance. */
export function generateGraticule(zoom = 2): GraticuleData {
  const { major, minor } = stepsForZoom(zoom)
  const cacheKey = `${major}/${minor ?? 0}`
  const cached = graticuleCache.get(cacheKey)
  if (cached) return cached

  // Pre-size: rough vertex count estimate for the major+minor pair.
  // Each call to lonLatToMercDSFUN pushes 6 floats. Empirical for the
  // densest bucket (z>=9, major=1, minor=0.5): ~130k vertex pushes.
  // We slightly overshoot and trim — much faster than push() growth
  // which copies on every doubling.
  const vertices: number[] = []
  const segmentStep = 2

  function addMeridians(step: number, featId: number, skipStep?: number) {
    for (let lon = -180; lon < 180; lon += step) {
      if (skipStep && lon % skipStep === 0) continue
      for (let lat = -90; lat < 90; lat += segmentStep) {
        lonLatToMercDSFUN(lon, lat, featId, vertices)
        lonLatToMercDSFUN(lon, Math.min(lat + segmentStep, 90), featId, vertices)
      }
    }
  }
  function addParallels(step: number, featId: number, skipStep?: number) {
    for (let lat = -90 + step; lat < 90; lat += step) {
      if (skipStep && (lat + 90) % skipStep === 0) continue
      for (let lon = -180; lon < 180; lon += segmentStep) {
        lonLatToMercDSFUN(lon, lat, featId, vertices)
        lonLatToMercDSFUN(Math.min(lon + segmentStep, 180), lat, featId, vertices)
      }
    }
  }

  addMeridians(major, 1)
  addParallels(major, 1)
  if (minor) {
    addMeridians(minor, 0, major)
    addParallels(minor, 0, major)
  }

  const data: GraticuleData = {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 6,
  }
  graticuleCache.set(cacheKey, data)
  return data
}

/** Generate a circle outline for globe projections (orthographic, etc.) */
export function generateGlobeOutline(segments = 128): GraticuleData {
  const vertices: number[] = []
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2
    const a2 = ((i + 1) / segments) * Math.PI * 2
    lonLatToMercDSFUN(Math.cos(a1) * 89.99, Math.sin(a1) * 89.99, 0, vertices)
    lonLatToMercDSFUN(Math.cos(a2) * 89.99, Math.sin(a2) * 89.99, 0, vertices)
  }

  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 6,
  }
}

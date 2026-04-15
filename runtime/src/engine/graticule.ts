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

/** Generate graticule grid lines for a given zoom level */
export function generateGraticule(zoom = 2): GraticuleData {
  const { major, minor } = stepsForZoom(zoom)
  const vertices: number[] = []
  const segmentStep = 2

  // Helper: add lines for a given step, skipping multiples of `skipStep`
  function addMeridians(step: number, featId: number, skipStep?: number) {
    for (let lon = -180; lon < 180; lon += step) {
      if (skipStep && lon % skipStep === 0) continue // skip major lines
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

  // Major lines (feat_id = 1)
  addMeridians(major, 1)
  addParallels(major, 1)

  // Minor lines (feat_id = 0) — skip where major already drawn
  if (minor) {
    addMeridians(minor, 0, major)
    addParallels(minor, 0, major)
  }

  // Stride 6 f32 per vertex
  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 6,
  }
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

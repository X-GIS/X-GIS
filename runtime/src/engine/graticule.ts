// ═══ Graticule (위경도 그리드 라인) + Globe Background ═══
// GPU 프로젝션과 함께 동작. 줌 적응형 간격 + 메이저/마이너 구분.

export interface GraticuleData {
  /** Line segments stride 4: [lon, lat, feat_id, arc_start]. arc_start is
   *  unused for graticule (always 0) but kept to match the line pipeline's
   *  stride-16 vertex buffer layout. feat_id: 1 = major, 0 = minor. */
  vertices: Float32Array
  indexCount: number
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
        vertices.push(lon, lat, featId, 0)
        vertices.push(lon, Math.min(lat + segmentStep, 90), featId, 0)
      }
    }
  }

  function addParallels(step: number, featId: number, skipStep?: number) {
    for (let lat = -90 + step; lat < 90; lat += step) {
      if (skipStep && (lat + 90) % skipStep === 0) continue
      for (let lon = -180; lon < 180; lon += segmentStep) {
        vertices.push(lon, lat, featId, 0)
        vertices.push(Math.min(lon + segmentStep, 180), lat, featId, 0)
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

  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 4,
  }
}

/** Generate a circle outline for globe projections (orthographic, etc.) */
export function generateGlobeOutline(segments = 128): GraticuleData {
  const vertices: number[] = []
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2
    const a2 = ((i + 1) / segments) * Math.PI * 2
    vertices.push(Math.cos(a1) * 89.99, Math.sin(a1) * 89.99, 0, 0)
    vertices.push(Math.cos(a2) * 89.99, Math.sin(a2) * 89.99, 0, 0)
  }

  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 4,
  }
}

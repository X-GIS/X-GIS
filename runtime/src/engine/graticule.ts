// ═══ Graticule (위경도 그리드 라인) + Globe Background ═══
// GPU 프로젝션과 함께 동작

export interface GraticuleData {
  /** Line segments: [lon1, lat1, feat_id, lon2, lat2, feat_id, ...] in degrees (stride 3) */
  vertices: Float32Array
  indexCount: number
}

/** Generate graticule grid lines every `step` degrees */
export function generateGraticule(step = 15): GraticuleData {
  const vertices: number[] = []
  const segmentStep = 2

  // Longitude lines (meridians)
  for (let lon = -180; lon <= 180; lon += step) {
    for (let lat = -90; lat < 90; lat += segmentStep) {
      vertices.push(lon, lat, 0)
      vertices.push(lon, Math.min(lat + segmentStep, 90), 0)
    }
  }

  // Latitude lines (parallels)
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let lon = -180; lon < 180; lon += segmentStep) {
      vertices.push(lon, lat, 0)
      vertices.push(Math.min(lon + segmentStep, 180), lat, 0)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 3, // stride 3: each vertex is lon,lat,feat_id
  }
}

/** Generate a circle outline for globe projections (orthographic, etc.) */
export function generateGlobeOutline(segments = 128): GraticuleData {
  const vertices: number[] = []
  // Circle in projected space — generated as lon/lat on the "edge" of visible hemisphere
  // For a globe centered on (clon, clat), the visible edge is a great circle
  // We approximate with a circle in screen space, which will be overridden by the shader

  // Actually, for orthographic, the outline is just a circle of radius EARTH_R
  // We generate it as a sequence of points at exactly 90° from center
  // The vertex shader will project these to form a perfect circle
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2
    const a2 = ((i + 1) / segments) * Math.PI * 2
    // Points on the edge of the visible hemisphere
    // We'll use a trick: emit lon/lat pairs that are 90° from any center
    // These represent the "horizon" of the globe
    // Using equator-centered coordinates that the shader will transform
    vertices.push(Math.cos(a1) * 89.99, Math.sin(a1) * 89.99, 0)
    vertices.push(Math.cos(a2) * 89.99, Math.sin(a2) * 89.99, 0)
  }

  return {
    vertices: new Float32Array(vertices),
    indexCount: vertices.length / 3,
  }
}

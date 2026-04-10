// ═══ Globe Mesh — UV 구체 생성 ═══
// 구면 프로젝션용 메시. 텍스처 좌표 = lon/lat → [0,1] 매핑.

export interface SphereMesh {
  vertices: Float32Array  // [x, y, z, u, v, ...] interleaved
  indices: Uint32Array
  vertexCount: number
  indexCount: number
}

/**
 * Generate a UV sphere mesh.
 * @param latSegments - 위도 방향 분할 수 (높을수록 부드러움)
 * @param lonSegments - 경도 방향 분할 수
 * @param radius - 구 반지름
 */
export function generateGlobeMesh(
  latSegments = 64,
  lonSegments = 128,
  radius = 1.0,
): SphereMesh {
  const vertices: number[] = []
  const indices: number[] = []

  // Generate vertices
  for (let lat = 0; lat <= latSegments; lat++) {
    const theta = (lat / latSegments) * Math.PI // 0 → PI (north pole → south pole)
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)

    for (let lon = 0; lon <= lonSegments; lon++) {
      const phi = (lon / lonSegments) * 2 * Math.PI // 0 → 2PI

      // 3D position on sphere
      const x = radius * sinTheta * Math.cos(phi)
      const y = radius * cosTheta  // Y-up
      const z = radius * sinTheta * Math.sin(phi)

      // UV: u = longitude [0,1], v = latitude [0,1]
      const u = lon / lonSegments
      const v = lat / latSegments

      vertices.push(x, y, z, u, v)
    }
  }

  // Generate indices (triangle strip → triangle list)
  for (let lat = 0; lat < latSegments; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      const curr = lat * (lonSegments + 1) + lon
      const next = curr + lonSegments + 1

      // Two triangles per quad
      indices.push(curr, next, curr + 1)
      indices.push(curr + 1, next, next + 1)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: (latSegments + 1) * (lonSegments + 1),
    indexCount: indices.length,
  }
}

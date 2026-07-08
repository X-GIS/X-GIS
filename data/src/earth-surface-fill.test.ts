import { describe, it, expect } from 'vitest'
import { generateEarthSurfaceFillMesh } from './earth-surface-fill'
// worldBandForProjType + MERCATOR_LAT_LIMIT stay in @xgis/engine (projections-table
// is the authority); only the mesh generator moved to @xgis/data (#781).
import { worldBandForProjType, MERCATOR_LAT_LIMIT } from '@xgis/engine'

describe('worldBandForProjType', () => {
  it('Mercator/equirect/oblique-mercator → mercator-clamped band', () => {
    expect(worldBandForProjType(0)).toBe('mercator-clamped')
    expect(worldBandForProjType(1)).toBe('mercator-clamped')
    expect(worldBandForProjType(6)).toBe('mercator-clamped')
  })

  it('Natural Earth → natural-earth band', () => {
    expect(worldBandForProjType(2)).toBe('natural-earth')
  })

  it('Orthographic/Azimuthal-eq/Stereographic/Globe → sphere-full band', () => {
    expect(worldBandForProjType(3)).toBe('sphere-full')
    expect(worldBandForProjType(4)).toBe('sphere-full')
    expect(worldBandForProjType(5)).toBe('sphere-full')
    expect(worldBandForProjType(7)).toBe('sphere-full')
  })
})

describe('generateEarthSurfaceFillMesh', () => {
  it('rejects density below Phase 2 spec minimum (32x16)', () => {
    expect(() => generateEarthSurfaceFillMesh(16, 16, 'sphere-full')).toThrow(/32x16/)
    expect(() => generateEarthSurfaceFillMesh(32, 8, 'mercator-clamped')).toThrow(/32x16/)
  })

  it('produces (cols × rows × 2) vertex floats at minimum density', () => {
    const { vertices } = generateEarthSurfaceFillMesh(32, 16, 'sphere-full')
    // 33 cols × 17 rows × 2 floats = 1122
    expect(vertices.length).toBe(33 * 17 * 2)
  })

  it('produces 6 indices per grid cell (2 triangles)', () => {
    const { indices } = generateEarthSurfaceFillMesh(32, 16, 'sphere-full')
    expect(indices.length).toBe(32 * 16 * 6)
  })

  it('first vertex is the south-west corner of the band', () => {
    const { vertices } = generateEarthSurfaceFillMesh(32, 16, 'mercator-clamped')
    expect(vertices[0]).toBe(-180) // lon
    expect(vertices[1]).toBeCloseTo(-MERCATOR_LAT_LIMIT, 5) // lat
  })

  it('last vertex is the north-east corner of the band', () => {
    const { vertices } = generateEarthSurfaceFillMesh(32, 16, 'mercator-clamped')
    const last = vertices.length - 2
    expect(vertices[last]).toBeCloseTo(180, 5) // lon
    expect(vertices[last + 1]).toBeCloseTo(MERCATOR_LAT_LIMIT, 5) // lat
  })

  it('sphere-full band reaches the geographic poles', () => {
    const { vertices } = generateEarthSurfaceFillMesh(32, 16, 'sphere-full')
    expect(vertices[1]).toBeCloseTo(-90, 5)
    expect(vertices[vertices.length - 1]).toBeCloseTo(90, 5)
  })

  it('longitude column 0 starts at -180 for every row', () => {
    const { vertices } = generateEarthSurfaceFillMesh(32, 16, 'sphere-full')
    const cols = 33
    for (let y = 0; y < 17; y++) {
      const lonAtCol0 = vertices[y * cols * 2]
      expect(lonAtCol0).toBe(-180)
    }
  })

  it('mesh winding produces CCW triangles in lon/lat space', () => {
    // First cell: (0, 0), (1, 0), (0, 1), (1, 0), (1, 1), (0, 1).
    // Cross-product of edge0-edge1 in lon/lat (= screen-space if we treat
    // lon=x, lat=y) should be positive for CCW.
    const { vertices, indices } = generateEarthSurfaceFillMesh(32, 16, 'sphere-full')
    const a = [vertices[indices[0] * 2], vertices[indices[0] * 2 + 1]]
    const b = [vertices[indices[1] * 2], vertices[indices[1] * 2 + 1]]
    const c = [vertices[indices[2] * 2], vertices[indices[2] * 2 + 1]]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    expect(cross).toBeGreaterThan(0)
  })
})

// Pin polar-cap detector — first step toward fixing the globe pole
// hole (project_polar_cap_gap_globe). The detector must:
//   - flag rings that touch the Web Mercator clamp boundary
//   - report contiguous spans (multi-vertex runs on the boundary)
//   - handle ring wrap-around (span crossing the array start)
//   - distinguish north vs south pole boundary

import { describe, it, expect } from 'vitest'
import { findClampBoundarySpans, synthesizeCapRing, vertexOnClampBoundary, type CapSpan } from './polar-cap-detect'

const LIMIT = 85.0511287798066

describe('vertexOnClampBoundary', () => {
  it('returns +1 at exact north clamp', () => {
    expect(vertexOnClampBoundary(LIMIT)).toBe(1)
  })
  it('returns -1 at exact south clamp', () => {
    expect(vertexOnClampBoundary(-LIMIT)).toBe(-1)
  })
  it('returns 0 in normal range', () => {
    for (const lat of [0, 45, -45, 80, -80, 84]) {
      expect(vertexOnClampBoundary(lat)).toBe(0)
    }
  })
  it('tolerates 100m epsilon (tile quantisation)', () => {
    expect(vertexOnClampBoundary(LIMIT - 0.0005)).toBe(1)
    expect(vertexOnClampBoundary(LIMIT - 0.005)).toBe(0)
  })
})

describe('findClampBoundarySpans', () => {
  it('returns empty for ring fully inside clamp band', () => {
    const ring: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    expect(findClampBoundarySpans(ring)).toEqual([])
  })

  it('detects single south-pole span', () => {
    // Antarctica-like: most ring outside boundary, segment along -85°.
    const ring: Array<[number, number]> = [
      [0, -80],          // off-boundary
      [10, -80],
      [20, -85.0511],   // boundary start
      [30, -85.0511],
      [40, -85.0511],   // boundary end
      [50, -80],         // off-boundary
      [0, -80],          // close
    ]
    const spans = findClampBoundarySpans(ring)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.pole).toBe(-1)
    expect(spans[0]!.startLon).toBe(20)
    expect(spans[0]!.endLon).toBe(40)
  })

  it('detects two separate spans on opposite poles', () => {
    // Synthetic ring touching both clamps — flagged as two spans.
    const ring: Array<[number, number]> = [
      [0, 0],
      [10, LIMIT],
      [20, LIMIT],
      [30, 0],
      [40, -LIMIT],
      [50, -LIMIT],
      [60, 0],
      [0, 0],
    ]
    const spans = findClampBoundarySpans(ring)
    expect(spans).toHaveLength(2)
    expect(spans.find(s => s.pole === 1)?.startLon).toBe(10)
    expect(spans.find(s => s.pole === -1)?.startLon).toBe(40)
  })

  it('handles span that wraps the ring start', () => {
    // First two and last two vertices are on the south clamp.
    const ring: Array<[number, number]> = [
      [-170, -LIMIT],   // wrap-end of southern span
      [-160, -LIMIT],
      [-150, -80],       // off-boundary
      [-140, -80],
      [-130, -80],
      [-180, -LIMIT],   // wrap-start of southern span
    ]
    const spans = findClampBoundarySpans(ring)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.pole).toBe(-1)
  })

  it('whole ring on boundary reports single span covering it all', () => {
    const ring: Array<[number, number]> = [
      [-180, -LIMIT], [-90, -LIMIT], [0, -LIMIT],
      [90, -LIMIT], [180, -LIMIT],
    ]
    const spans = findClampBoundarySpans(ring)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.pole).toBe(-1)
    expect(spans[0]!.startIdx).toBe(0)
    expect(spans[0]!.endIdx).toBe(4)
  })

  it('returns empty for empty / degenerate ring', () => {
    expect(findClampBoundarySpans([])).toEqual([])
    expect(findClampBoundarySpans([[0, 0]])).toEqual([])
  })
})

describe('synthesizeCapRing', () => {
  it('south-pole span produces a closed ring with pole vertex at lat=-90', () => {
    const span: CapSpan = {
      pole: -1,
      startIdx: 0, endIdx: 4,
      startLon: -180, endLon: 180,
    }
    const ring = synthesizeCapRing(span, 8)
    expect(ring.length).toBeGreaterThan(2)
    expect(ring[0]).toEqual(ring[ring.length - 1]) // closed
    const polePoint = ring.find(([, lat]) => lat === -90)
    expect(polePoint, 'must include pole vertex at lat=-90').toBeDefined()
  })

  it('north-pole span produces ring with pole vertex at lat=+90', () => {
    const span: CapSpan = {
      pole: 1,
      startIdx: 0, endIdx: 1,
      startLon: -10, endLon: 10,
    }
    const ring = synthesizeCapRing(span, 4)
    expect(ring.find(([, lat]) => lat === 90)).toBeDefined()
  })

  it('boundary vertices interpolated at MERCATOR_LAT_LIMIT', () => {
    const span: CapSpan = {
      pole: -1,
      startIdx: 0, endIdx: 1,
      startLon: 0, endLon: 90,
    }
    const ring = synthesizeCapRing(span, 4)
    const boundaryPoints = ring.filter(([, lat]) => Math.abs(lat + LIMIT) < 1e-6)
    expect(boundaryPoints.length).toBeGreaterThanOrEqual(5) // 4 subdivisions + endpoints
  })

  it('subdivision count controls ring vertex density', () => {
    const span: CapSpan = {
      pole: -1,
      startIdx: 0, endIdx: 0,
      startLon: -180, endLon: 180,
    }
    const ring4 = synthesizeCapRing(span, 4)
    const ring32 = synthesizeCapRing(span, 32)
    expect(ring32.length).toBeGreaterThan(ring4.length)
  })

  it('antimeridian-crossing span wraps correctly', () => {
    // startLon=170, endLon=-170 — span crosses antimeridian.
    const span: CapSpan = {
      pole: -1,
      startIdx: 0, endIdx: 1,
      startLon: 170, endLon: -170,
    }
    const ring = synthesizeCapRing(span, 4)
    // All longitudes must be in [-180, 180].
    for (const [lon] of ring) {
      expect(lon).toBeGreaterThanOrEqual(-180)
      expect(lon).toBeLessThanOrEqual(180)
    }
  })
})

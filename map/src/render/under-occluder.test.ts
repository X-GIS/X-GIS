// INC-1 under-occluder — pure (no-GPU) regression guards for the two invariants
// that make the sphere a correct depth/colour floor: (1) the shader z-registers
// with the vector fills (same eye-horizon cull + log-depth) and covers only the
// near hemisphere, and (2) every mesh vertex is seated JUST UNDER the surface so
// a real fill at EARTH_R wins the depth test and the disc never grows past the limb.

import { describe, it, expect } from 'vitest'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import { emitUnderOccluderWgsl } from '../shaders/dsl/under-occluder'
import { buildUnderOccluderMesh, UNDER_OCCLUDER_RADIUS_SCALE } from './under-occluder-renderer'

describe('under-occluder shader', () => {
  const wgsl = emitUnderOccluderWgsl(false)

  it('emits the globe entry points', () => {
    expect(wgsl).toContain('fn vs_occluder(')
    expect(wgsl).toContain('fn fs_occluder(')
  })

  it('reuses the polygon eye-horizon cull so the silhouette matches the fill limb', () => {
    // needs_backface_cull(...) < 0 → discard: no colour ring past the true limb.
    expect(wgsl).toContain('needs_backface_cull(')
    expect(wgsl).toContain('discard')
    expect(wgsl).toContain('rim_alpha(')
  })

  it('writes the SAME log-depth as the fills so it z-registers', () => {
    expect(wgsl).toContain('apply_log_depth(')
    expect(wgsl).toContain('compute_log_frag_depth(')
  })

  it('pick variant adds the rg32uint pick attachment (opaque-pass MRT match)', () => {
    expect(wgsl).not.toContain('vec2<u32>') // non-pick: single colour target
    expect(emitUnderOccluderWgsl(true)).toContain('vec2<u32>') // pick: writes (0,0)
  })
})

describe('under-occluder mesh', () => {
  const { vertices, indices } = buildUnderOccluderMesh()
  const stride = 5

  it('seats it UNDER EARTH_R (radius scale strictly < 1)', () => {
    expect(UNDER_OCCLUDER_RADIUS_SCALE).toBeLessThan(1)
    expect(UNDER_OCCLUDER_RADIUS_SCALE).toBeGreaterThan(0.99) // a sub-pixel inset, not a shrunk disc
  })

  it('every vertex ECEF = (1−ε)·lonLatToECEF(lon,lat) — inside the ellipsoid', () => {
    const n = vertices.length / stride
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 200))) {
      const ex = vertices[i * stride]
      const ey = vertices[i * stride + 1]
      const ez = vertices[i * stride + 2]
      const lon = vertices[i * stride + 3]
      const lat = vertices[i * stride + 4]
      const [rx, ry, rz] = lonLatToECEF(lon, lat)
      const surfR = Math.hypot(rx, ry, rz)
      const vR = Math.hypot(ex, ey, ez)
      // seated inward by exactly the radius scale, and strictly under the surface
      expect(vR).toBeCloseTo(surfR * UNDER_OCCLUDER_RADIUS_SCALE, 0)
      expect(vR).toBeLessThan(surfR)
    }
  })

  it('reaches both geographic poles (closes the ±90 cap)', () => {
    const n = vertices.length / stride
    const lats = new Set<number>()
    for (let i = 0; i < n; i++) lats.add(vertices[i * stride + 4])
    expect(lats.has(90)).toBe(true)
    expect(lats.has(-90)).toBe(true)
  })

  it('emits a well-formed triangle index buffer', () => {
    expect(indices.length % 3).toBe(0)
    expect(indices.length).toBeGreaterThan(0)
    const maxIdx = vertices.length / stride - 1
    for (let i = 0; i < indices.length; i++) expect(indices[i]).toBeLessThanOrEqual(maxIdx)
  })

  it('the inward inset is far coarser than sub-metre (well clear of log-depth resolution)', () => {
    // ε·EARTH_R must be metres-scale so the fill at EARTH_R unambiguously wins.
    const inset = (1 - UNDER_OCCLUDER_RADIUS_SCALE) * EARTH.sphereR
    expect(inset).toBeGreaterThan(100) // hundreds of metres → no depth ambiguity
  })
})

// ═══ Coverage mesh nodes — the CRS-correct drape geometry (#1366 INC-3) ═══
//
// Two claims carry this increment, and both are gated here rather than left to the eye:
//
//   1. A GEOGRAPHIC cell is unchanged BY CONSTRUCTION. The node grid must reproduce the
//      shader's existing `mix(cov_edges, u01)` arithmetic exactly — not "within a
//      tolerance", exactly — or every S-111 cell shipping today moves.
//   2. A PROJECTED cell's residual is MESH-INTERPOLATION error, and it is a number.
//      The design claims it is bounded and sub-texel at N=64; that claim is measured
//      against proj4 here, so a future mesh-density change cannot quietly break it.
//
// Also pinned: the uv-varying equivalence that lets the fragment stop inverting uv out
// of geography (`uTex == u01` for the geographic case), which is what makes the shader
// change safe to make in the same increment.

import { describe, it, expect } from 'vitest'
import { coverageEdges, coverageMeshNodes, isGeographicCRS, meshInterpolationError } from './mesh-nodes'
import type { CoverageHeader } from './format'

function header(over: Partial<CoverageHeader> = {}): CoverageHeader {
  return {
    product: 's102',
    crs: 'EPSG:4326',
    origin: [5, 50],
    spacing: [2, 1],
    size: [3, 2],
    registration: 'point',
    bands: [],
    vertical: { datumCode: 23, sign: 'down' },
    time: null,
    ...over,
  }
}

/** The REAL NOAA S-102 Chesapeake cell's geometry: UTM 18N, 16 m cells, 1663×2090. */
const CHESAPEAKE = header({
  crs: 'EPSG:32618',
  origin: [420767.84475419234, 4183856.856912584],
  spacing: [16, 16],
  size: [1663, 2090],
})

const node = (nodes: Float32Array, n: number, gx: number, gy: number): [number, number] => {
  const i = (gy * (n + 1) + gx) * 2
  return [nodes[i]!, nodes[i + 1]!]
}

describe('coverageEdges — the footprint, point registration', () => {
  it('runs half a cell beyond the outermost centres', () => {
    // origin is the SW cell CENTRE, so the footprint starts half a cell south-west of it.
    expect(coverageEdges(header())).toEqual([4, 49.5, 10, 51.5])
  })
})

describe('a GEOGRAPHIC cell is unchanged by construction', () => {
  it('reproduces the shader mix() arithmetic exactly, node for node', () => {
    // This is the load-bearing back-compat gate. It re-derives the shader's own line
    // (`mix(edges.x, edges.z, u01)`) independently and demands EXACT equality — an
    // approximation here would move every geographic coverage shipping today.
    const n = 8
    const h = header()
    const [west, south, east, north] = coverageEdges(h)
    const nodes = coverageMeshNodes(h, n)
    for (let gy = 0; gy <= n; gy++) {
      for (let gx = 0; gx <= n; gx++) {
        const expLon = Math.fround(west + (east - west) * (gx / n))
        const expLat = Math.fround(south + (north - south) * (gy / n))
        expect(node(nodes, n, gx, gy)).toEqual([expLon, expLat])
      }
    }
  })

  it('pins the footprint corners exactly', () => {
    const n = 64
    const nodes = coverageMeshNodes(header(), n)
    expect(node(nodes, n, 0, 0)).toEqual([4, 49.5]) // SW
    expect(node(nodes, n, n, 0)).toEqual([10, 49.5]) // SE
    expect(node(nodes, n, 0, n)).toEqual([4, 51.5]) // NW
    expect(node(nodes, n, n, n)).toEqual([10, 51.5]) // NE
  })

  it('has ZERO interpolation error — the mesh IS the mapping there', () => {
    expect(meshInterpolationError(header(), 8)).toBe(0)
  })

  it('uv == u01, which is what lets the fragment stop inverting uv out of geography', () => {
    // The shader computes uTex = (lon − westEdge)/(nLon·dLon). At a node,
    // lon = west + u01·(east − west) and (east − west) = nLon·dLon, so uTex === u01.
    // Proving it here is what makes replacing that line with a passed-through varying a
    // no-op for geographic cells instead of a behaviour change.
    const n = 16
    const h = header()
    const [west] = coverageEdges(h)
    const spanLon = h.size[0] * h.spacing[0]
    const nodes = coverageMeshNodes(h, n)
    for (let gx = 0; gx <= n; gx++) {
      const [lon] = node(nodes, n, gx, 0)
      expect((lon - west) / spanLon).toBeCloseTo(gx / n, 6)
    }
  })
})

describe('a PROJECTED cell is placed through its own CRS', () => {
  it('puts the real Chesapeake cell in Chesapeake Bay, not at 420 000°', () => {
    const n = 8
    const nodes = coverageMeshNodes(CHESAPEAKE, n)
    for (let gy = 0; gy <= n; gy++) {
      for (let gx = 0; gx <= n; gx++) {
        const [lon, lat] = node(nodes, n, gx, gy)
        expect(lon).toBeGreaterThan(-76.1)
        expect(lon).toBeLessThan(-75.5)
        expect(lat).toBeGreaterThan(37.7)
        expect(lat).toBeLessThan(38.2)
      }
    }
    // …and the cell's own declared geographic bounds agree with the mesh corners.
    // (The real cell declares west −75.90007, south 37.79858, east −75.60030, north 38.10188.)
    const [swLon, swLat] = node(nodes, n, 0, 0)
    expect(swLon).toBeCloseTo(-75.9, 2)
    expect(swLat).toBeCloseTo(37.8, 2)
  })

  it('the footprint is NOT a lon/lat rectangle — the edges curve', () => {
    // The whole reason this increment exists. If a UTM footprint were lon/lat-
    // rectangular, `mix(cov_edges, u01)` would have been fine and no mesh would be
    // needed. The south edge's latitude must vary along it.
    const n = 16
    const nodes = coverageMeshNodes(CHESAPEAKE, n)
    const lats: number[] = []
    for (let gx = 0; gx <= n; gx++) lats.push(node(nodes, n, gx, 0)[1])
    const spread = Math.max(...lats) - Math.min(...lats)
    expect(spread).toBeGreaterThan(1e-4) // curvature is real, not float noise
  })

  it('rejects a CRS the registry cannot resolve, rather than guessing', () => {
    // A mesh built from an unresolvable CRS is a grid placed by guesswork.
    expect(() => coverageMeshNodes(header({ crs: 'EPSG:9999' }), 4)).toThrow(
      /Unsupported EPSG code/,
    )
  })
})

describe('error budget — measured, and it is TWO different residuals', () => {
  const M_PER_DEG = 111_320
  const CELL_M = 16

  it('the INTERPOLATION term converges quadratically and is millimetres at N=64', () => {
    // Doubling the mesh must quarter this term — that is what makes it interpolation
    // error rather than a constant bias from a wrong projection, which is the failure
    // this budget exists to catch. Measured: 0.174 m @8 → 0.043 @16 → 0.011 @32 →
    // 0.0027 @64, i.e. ~4× per doubling.
    const e8 = meshInterpolationError(CHESAPEAKE, 8, 'f64')
    const e16 = meshInterpolationError(CHESAPEAKE, 16, 'f64')
    const e32 = meshInterpolationError(CHESAPEAKE, 32, 'f64')
    expect(e16 / e8).toBeLessThan(0.4) // quartering, with slack
    expect(e32 / e16).toBeLessThan(0.4)
    expect(meshInterpolationError(CHESAPEAKE, 64, 'f64') * M_PER_DEG).toBeLessThan(0.01) // < 1 cm
  })

  it('the SHIPPED path floors at f32 precision, NOT at mesh density', () => {
    // The finding that matters for tuning: past N≈16 a finer mesh buys nothing, because
    // node lon/lat reaches the GPU as f32 and half an ulp at lon ≈ −75.9 is ~0.42 m.
    // Anyone tempted to raise COVERAGE_GRID_N to reduce this should read this gate first.
    const halfUlpDeg = 2 ** Math.floor(Math.log2(75.9)) * 2 ** -23 * 0.5
    for (const n of [32, 64, 128]) {
      const err = meshInterpolationError(CHESAPEAKE, n, 'f32')
      expect(err).toBeGreaterThan(halfUlpDeg * 0.5) // the floor is real, not noise…
      expect(err).toBeLessThan(halfUlpDeg * 3) // …and it does not grow with density
    }
  })

  it('both residuals sit far inside one grid cell — the placement claim', () => {
    // The claim the design rests on: the drape places the grid to well within a cell, so
    // it cannot smear the data it is placing. 0.4 m of 16 m ≈ 2.6%.
    const shipped = meshInterpolationError(CHESAPEAKE, 64, 'f32') * M_PER_DEG
    expect(shipped).toBeLessThan(CELL_M / 10)
  })
})

describe('isGeographicCRS', () => {
  it('accepts WGS 84 2D and 3D only', () => {
    expect(isGeographicCRS('EPSG:4326')).toBe(true)
    expect(isGeographicCRS('EPSG:4979')).toBe(true)
    expect(isGeographicCRS('EPSG:32618')).toBe(false)
    expect(isGeographicCRS('EPSG:3857')).toBe(false) // projected, despite being "web"
  })
})

// ═══ Coverage mesh nodes — where each drape-mesh vertex sits in lon/lat (#1366 INC-3) ═══
//
// The coverage draw is not a quad: `vs_cov` emits an N×N mesh and projects EVERY vertex
// (map/src/shaders/dsl/coverage-ramp.ts). Today it derives each vertex's lon/lat inside
// the shader as `mix(cov_edges, u01)` — which silently assumes the footprint is a
// rectangle IN LON/LAT. Real S-102 cells are projected (UTM), where that is false: the
// footprint is a rectangle in the cell's own CRS and its edges curve in lon/lat.
//
// This computes the mesh's node positions on the CPU instead, in whatever CRS the cell
// declares, so the shader can read them instead of assuming. (N+1)² nodes at ~4k points
// per arm — computed once when a coverage is armed, never per frame, and never per
// fragment. No projection math enters a shader, so no second authority is created on the
// GPU for math the CPU already owns (CLAUDE.md §12).
//
// GEOGRAPHIC CELLS TAKE THE IDENTICAL ARITHMETIC the shader does today — same `mix`, same
// order — so the drape of every S-111/S-102 geographic cell is unchanged by construction,
// not merely by tolerance.

import proj4 from 'proj4'
import { resolveEPSG } from '../sources/epsg-defs'
import type { CoverageHeader } from './format'

/** Outer cell EDGES of a coverage footprint, in the header's own CRS units:
 *  `[west, south, east, north]`. Registration is point (origin = SW cell CENTRE), so the
 *  footprint runs half a cell beyond the outermost centres. Mirrors what
 *  `CoverageRenderer.setCoverage` packs into `cov_edges`. */
export function coverageEdges(header: CoverageHeader): [number, number, number, number] {
  const [originX, originY] = header.origin
  const [dx, dy] = header.spacing
  const [nx, ny] = header.size
  const west = originX - dx / 2
  const south = originY - dy / 2
  return [west, south, west + nx * dx, south + ny * dy]
}

/** True when the header's CRS is one the mesh can be built for WITHOUT reprojection. */
export function isGeographicCRS(crs: string): boolean {
  return crs === 'EPSG:4326' || crs === 'EPSG:4979'
}

/** Lon/lat of every node of an `(n+1)×(n+1)` mesh over the coverage footprint, row-major
 *  from the SOUTH-WEST node (matching the shader's `u01` west→east, `v01` south→north),
 *  two floats per node.
 *
 *  A geographic cell takes the shader's own `mix` arithmetic verbatim. A projected cell
 *  walks the footprint in ITS OWN units and inverts each node through proj4.
 *
 *  Throws for a CRS `resolveEPSG` does not know — a mesh built from an unresolvable CRS
 *  would be a grid placed by guesswork. */
export function coverageMeshNodes(header: CoverageHeader, n: number): Float32Array {
  if (!Number.isInteger(n) || n < 1) throw new Error(`[coverage] mesh N must be ≥ 1, got ${n}`)
  const [west, south, east, north] = coverageEdges(header)
  const out = new Float32Array((n + 1) * (n + 1) * 2)
  const geographic = isGeographicCRS(header.crs)
  // resolveEPSG registers the def (deriving UTM on demand) and throws on an unknown code.
  const from = geographic ? null : resolveEPSG(header.crs)

  for (let gy = 0; gy <= n; gy++) {
    const v01 = gy / n
    // The shader's `mix(edges.y, edges.w, v01)`, same operand order.
    const y = south + (north - south) * v01
    for (let gx = 0; gx <= n; gx++) {
      const u01 = gx / n
      const x = west + (east - west) * u01
      const i = (gy * (n + 1) + gx) * 2
      if (from === null) {
        out[i] = x
        out[i + 1] = y
      } else {
        const [lon, lat] = proj4(from, 'EPSG:4326', [x, y]) as [number, number]
        out[i] = lon
        out[i + 1] = lat
      }
    }
  }
  return out
}

/** The worst distance, in DEGREES, between the mesh's linear interpolation and the true
 *  projection, sampled at each sub-quad's centre — the residual (C) trades for keeping
 *  the data unresampled. Zero for a geographic cell by construction (the interpolation
 *  IS the mapping there). Exported so the budget is measured, never assumed.
 *
 *  `precision` selects WHICH residual is measured, and the two are different things —
 *  measured on the real NOAA Chesapeake cell (UTM 18N, 16 m cells):
 *
 *  - `'f64'` isolates the INTERPOLATION term. It converges quadratically in the mesh
 *    density: 0.174 m at N=8 → 0.043 at 16 → 0.011 at 32 → **0.0027 at 64**.
 *  - `'f32'` (the default, and what actually ships, since node lon/lat reaches the GPU as
 *    f32) plateaus at ~0.3–0.4 m from N≈16 onward. That floor is NOT interpolation — it
 *    is half an f32 ulp at lon ≈ −75.9 (ulp = 7.63e-6° ≈ 0.85 m).
 *
 *  So past N≈16 a finer mesh buys nothing: f32 storage is the floor, not tessellation.
 *  Both terms sit far below a 16 m cell (0.4 m ≈ 2.6% of one), and the f32 floor is the
 *  SAME precision class the geographic path already lives with — the shader has always
 *  interpolated f32 lon/lat — so this is not a new error, only a newly measured one. */
export function meshInterpolationError(
  header: CoverageHeader,
  n: number,
  precision: 'f32' | 'f64' = 'f32',
): number {
  if (isGeographicCRS(header.crs)) return 0
  const [west, south, east, north] = coverageEdges(header)
  const from = resolveEPSG(header.crs)
  const nodes: number[] = []
  for (let gy = 0; gy <= n; gy++) {
    for (let gx = 0; gx <= n; gx++) {
      const x = west + (east - west) * (gx / n)
      const y = south + (north - south) * (gy / n)
      const [lo, la] = proj4(from, 'EPSG:4326', [x, y]) as [number, number]
      nodes.push(precision === 'f32' ? Math.fround(lo) : lo)
      nodes.push(precision === 'f32' ? Math.fround(la) : la)
    }
  }
  let worst = 0
  const at = (gx: number, gy: number): [number, number] => {
    const i = (gy * (n + 1) + gx) * 2
    return [nodes[i]!, nodes[i + 1]!]
  }
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      // Bilinear centre of the sub-quad, as the rasterizer would interpolate it.
      const [aLon, aLat] = at(gx, gy)
      const [bLon, bLat] = at(gx + 1, gy)
      const [cLon, cLat] = at(gx, gy + 1)
      const [dLon, dLat] = at(gx + 1, gy + 1)
      const iLon = (aLon + bLon + cLon + dLon) / 4
      const iLat = (aLat + bLat + cLat + dLat) / 4
      // The TRUE position of that same footprint fraction.
      const x = west + (east - west) * ((gx + 0.5) / n)
      const y = south + (north - south) * ((gy + 0.5) / n)
      const [tLon, tLat] = proj4(from, 'EPSG:4326', [x, y]) as [number, number]
      worst = Math.max(worst, Math.hypot(iLon - tLon, iLat - tLat))
    }
  }
  return worst
}

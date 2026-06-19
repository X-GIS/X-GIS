// #460 — the low-zoom full-fidelity floor (#360 F2, tolerance 0 at z<=3) is
// budget-capped so a DETAILED source (the 14 MB picking-demo countries.geojson
// ≈ 548k verts) no longer drops ~3.45M tris into the single z0 world tile
// (~5 s compile → fill + picking blank for seconds). Under budget → full
// fidelity (ocean inlets preserved, #360); over budget → zoom-scaled simplify.

import { describe, expect, it } from 'vitest'
import { GeoJSONVT } from './index'
import type { GeoJSONInput } from './types'

// A smooth dense world-spanning ring: at z0 nearly every vertex is sub-29km
// (the z0 tolerance) from its neighbours' chord, so simplification — once it is
// allowed to run — collapses it to a few hundred shape-defining points.
function denseRing(n: number): GeoJSONInput {
  const coords: number[][] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    coords.push([Math.cos(t) * 100, Math.sin(t) * 70])
  }
  coords.push(coords[0]!)
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }],
  }
}

function z0Points(idx: InstanceType<typeof GeoJSONVT>): number {
  const t = idx.getTile(0, 0, 0) as { features?: Array<{ geometry: number[][][] }> } | null
  let n = 0
  for (const f of t?.features ?? []) for (const ring of f.geometry) n += ring.length
  return n
}

describe('#460 — low-zoom vertex budget caps the z0 world tile', () => {
  it('a SMALL low-zoom input keeps FULL fidelity (tolerance 0, #360 inlets preserved)', () => {
    const pts = z0Points(new GeoJSONVT(denseRing(500)))
    expect(pts).toBeGreaterThan(450) // ~all 500 input verts survive
  })

  it('FAIL-BEFORE: a LARGE low-zoom input (> budget) is SIMPLIFIED at z0', () => {
    // Pre-#460 (tolerance 0 forced at z<=3) this kept all ~150k verts in the
    // z0 tile. Budget-capped, it simplifies to a few hundred.
    const pts = z0Points(new GeoJSONVT(denseRing(150_000)))
    expect(pts).toBeGreaterThan(0)       // not dropped entirely
    expect(pts).toBeLessThan(50_000)     // simplified well below the 150k input
  })
})

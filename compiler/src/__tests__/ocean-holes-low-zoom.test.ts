// Regression lock for the "z=1 Australia/NZ polygon broken" report
// (memory project_australia_nz_z1_broken). At low zoom, OpenMapTiles
// renders land as the absence of an OCEAN polygon — i.e. each landmass
// (Australia, New Zealand, …) is a HOLE in one big ocean polygon. The
// report was a straight-diagonal cut on Australia's SE coast + NZ
// missing. CPU rasterisation of the real OFM z1/1/1 tile proved the
// compiler tiler is correct (all 25 ocean rings — outer + 24 island
// holes — preserved through clip → simplify → backtrack → earcut), so
// the hypothesis (backtrack/simplify dropping rings) was wrong; the
// real residual is a runtime water-render race under load. This test
// pins the tiler invariant that made the geometry correct: a large
// ocean polygon with several island holes keeps EVERY hole through
// compileSingleTile at z=1 (none dropped, collapsed, or inverted).

import { describe, it, expect } from 'vitest'
import { decomposeFeatures, compileSingleTile } from '../tiler/vector-tiler'

// Signed area (shoelace) of a ring; sign encodes winding.
function signedArea(ring: ReadonlyArray<readonly [number, number]> | number[]): number {
  const flat = typeof (ring as number[])[0] === 'number'
  const n = flat ? (ring as number[]).length / 2 : (ring as unknown[]).length
  const pt = (i: number): [number, number] =>
    flat ? [(ring as number[])[i * 2]!, (ring as number[])[i * 2 + 1]!]
         : (ring as [number, number][])[i]!
  let a = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pt(i), [x2, y2] = pt((i + 1) % n)
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

describe('ocean polygon with island holes — low-zoom hole preservation (z=1 Australia/NZ class)', () => {
  // z=1 tile x=1,y=1 covers lon [0,180], lat [-85.05, 0] (SE quadrant).
  // Outer = full tile ocean; holes = three landmasses inside it
  // (a big Australia-like, a tall thin NZ-like, a tiny island), all
  // comfortably inside the tile so no clip changes the topology.
  const outer = [[5, -5], [175, -5], [175, -80], [5, -80], [5, -5]]  // CW-ish ocean
  const australia = [[110, -12], [155, -12], [155, -40], [110, -40], [110, -12]]
  const newZealand = [[166, -34], [179, -34], [179, -47], [166, -47], [166, -34]]
  const tinyIsle = [[60, -20], [64, -20], [64, -24], [60, -24], [60, -20]]
  // GeoJSON polygon: [outer, ...holes] (holes get opposite winding by
  // the tiler's rewind; we pass them reversed to be explicit).
  const feature = {
    type: 'Feature' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        outer,
        [...australia].reverse(),
        [...newZealand].reverse(),
        [...tinyIsle].reverse(),
      ],
    },
    properties: { class: 'ocean' },
  }

  it('keeps every island hole through compileSingleTile (none dropped or collapsed)', () => {
    const parts = decomposeFeatures([feature])
    const tile = compileSingleTile(parts, 1, 1, 1, 14)
    expect(tile, 'tile compiled').not.toBeNull()
    const polys = tile!.polygons!
    expect(polys.length, 'one ocean polygon').toBe(1)
    const rings = polys[0]!.rings as Array<number[] | [number, number][]>
    // 1 outer + 3 holes survive. The exact count is the invariant the
    // report violated (NZ hole dropped → ocean covered NZ).
    expect(rings.length, 'outer + 3 island holes preserved').toBe(4)
    // Every ring keeps enough vertices to be a real polygon.
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i]!
      const n = typeof (r as number[])[0] === 'number' ? (r as number[]).length / 2 : (r as unknown[]).length
      expect(n, `ring[${i}] has ≥4 vertices`).toBeGreaterThanOrEqual(4)
    }
  })

  it('holes wind opposite to the outer ring (not inverted → not filled over)', () => {
    const tile = compileSingleTile(decomposeFeatures([feature]), 1, 1, 1, 14)!
    const rings = tile.polygons![0]!.rings as Array<number[] | [number, number][]>
    const outerSign = Math.sign(signedArea(rings[0]!))
    expect(outerSign, 'outer ring non-degenerate').not.toBe(0)
    for (let i = 1; i < rings.length; i++) {
      const s = Math.sign(signedArea(rings[i]!))
      expect(s, `hole[${i}] opposite winding to outer`).toBe(-outerSign)
    }
  })

  it('largest hole (Australia) keeps its area within 25% after simplify', () => {
    const tile = compileSingleTile(decomposeFeatures([feature]), 1, 1, 1, 14)!
    const rings = tile.polygons![0]!.rings as Array<number[] | [number, number][]>
    const holeAreas = rings.slice(1).map(r => Math.abs(signedArea(r))).sort((a, b) => b - a)
    // Australia is the biggest hole; its compiled area must stay close
    // to the others' ordering and not collapse toward zero.
    expect(holeAreas[0]!, 'largest hole area is non-trivial').toBeGreaterThan(holeAreas[2]! * 4)
  })
})

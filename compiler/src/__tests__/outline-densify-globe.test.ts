import { describe, it, expect } from 'vitest'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'

// #585 regression gate. A polygon OUTLINE under globe / non-Mercator projection must
// follow the great-circle curve, not stroke a straight chord across the sphere. The
// clipped-ring outline is stroked as raw chords (`augmentChainWithArc` inserts no
// vertices); cc497884 densified it to the FILL's angular gate, but #387's parallel
// outline path silently dropped that densification on merge. `subdivideChainMM` restores
// it. This is the fail-before gate: without the densify the long edge keeps its raw
// chord vertices (a handful); with it the edge is subdivided to <=2deg sub-segments.

const STRIDE = 10 // outlineVertices: [mx_h, my_h, mx_l, my_l, feat, arc, tinX, tinY, toutX, toutY]

function bigEquatorBox() {
  // A box spanning 60deg of longitude at the equator. Each horizontal edge is a 60deg
  // arc — far above MAX_TRI_DEGREES_FOR_PROJ (2deg), so densification splits it into
  // ~32 sub-segments (depth cap 5). It sits inside the single z0 world tile.
  const ring: [number, number][] = [
    [-30, -3],
    [30, -3],
    [30, 3],
    [-30, 3],
    [-30, -3],
  ]
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id: 1,
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: {},
      },
    ],
  }
}

describe('polygon outline great-circle densification (#585)', () => {
  it('densifies a long low-latitude outline edge at z0', () => {
    const set = compileGeoJSONToTiles(bigEquatorBox(), { minZoom: 0, maxZoom: 0 })
    const level = set.levels.find((l) => l.zoom === 0)
    expect(level, 'z0 level compiled').toBeDefined()

    let outlineVerts = 0
    for (const [, tile] of level!.tiles) {
      if (tile.outlineVertices) outlineVerts += tile.outlineVertices.length / STRIDE
    }
    // Raw box ring is ~5 vertices. After densification each 60deg edge contributes
    // ~32 sub-segments, so the outline must hold dozens of vertices. Fail-before
    // (un-densified raw chords) lands well under 15.
    expect(outlineVerts, `outline vertex count = ${outlineVerts}`).toBeGreaterThan(40)
  })
})

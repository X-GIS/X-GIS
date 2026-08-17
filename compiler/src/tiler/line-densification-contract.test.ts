import { describe, expect, it } from 'vitest'
import { decomposeFeatures } from './vector-tiler'
import type { GeoJSONFeature } from './geojson-types'

// The single place line geometry gets densified, gated at the stage that owns it.
//
// #1497 briefly added a second great-circle pass in `decodeMvtTile`, on the
// premise that fetched vector tiles were the one source path with no
// subdivision. They are not: EVERY source — fetched MVT, local GeoJSON, and
// X-GIS's own tiler output alike — reaches the GPU through `decomposeFeatures`,
// whose `makeLinePart` already calls `subdivideLine`. Measured on four
// parallels of 30° chords, the counts are identical with and without the
// decoder pass:
//
//     decoder pass ON    decode 784 → parts 917 → lineVerts 232
//     decoder pass OFF   decode  36 → parts 917 → lineVerts 232
//
// So the decoder pass was reverted as redundant, and these tests moved here to
// keep the invariant gated at the stage that actually provides it. They assert
// the CONTRACT — no emitted edge exceeds the subdivision bound, the invariants
// hold — not `subdivideLine`'s exact output, so refining that function
// does not break them.
//
// Why the bound matters: a line of constant latitude is straight in Mercator
// and a curve in every other projection, so a 30° authored edge is a chord
// across that curve. Source data legitimately encodes parallels that coarsely
// (the MapLibre demotiles geolines layer does exactly this).

/** Longest great-circle edge in a polyline, in degrees. */
const maxEdgeDeg = (coords: number[][]): number => {
  let worst = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i]
    const [lon2, lat2] = coords[i + 1]
    const r = Math.PI / 180
    const c =
      Math.sin(lat1 * r) * Math.sin(lat2 * r) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
    worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, c))) / r)
  }
  return worst
}

const lineParts = (coordinates: number[][]): number[][][] => {
  const feature = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {},
  } as unknown as GeoJSONFeature
  return decomposeFeatures([feature])
    .filter((p) => p.type === 'line')
    .map((p) => (p as { coords: number[][] }).coords)
}

describe('decomposeFeatures — line densification contract (#1497)', () => {
  it('breaks a world-spanning edge into sub-degree pieces', () => {
    // A single 120° authored edge — the shape a z0-z2 coastline tile contains.
    const parts = lineParts([
      [-60, 10],
      [60, 10],
    ])
    expect(parts).not.toHaveLength(0)
    const all = parts.flat()
    expect(all.length).toBeGreaterThan(60)
    for (const coords of parts) expect(maxEdgeDeg(coords)).toBeLessThan(2)
  })

  it('leaves an already-short edge alone', () => {
    // Below the 0.5° skip threshold: dense geometry must not be perturbed, and
    // the high-zoom case (every tile above ~z9 spans less than this) must not
    // pay for a subdivision it does not need.
    const src = [
      [10, 20],
      [10.1, 20.05],
      [10.2, 20.1],
    ]
    const parts = lineParts(src)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toHaveLength(src.length)
  })

  it('keeps a >±180 antimeridian wrap monotone', () => {
    // MapLibre's convention authors a seam-crossing line past ±180 so the
    // renderer can draw it at world-copy +1. Interpolated vertices must stay on
    // that same 360° branch — the great-circle interpolant folded 185° back to
    // -175° and shredded the polyline into ±360° jumps at the seam (#1221).
    const parts = lineParts([
      [170, 0],
      [190, 0],
    ])
    expect(parts).not.toHaveLength(0)
    // Non-vacuity: with only the two authored vertices the monotone check below
    // is trivially true. The interpolated vertices are the ones at risk.
    const primary = parts.find((c) => c.length > 2)
    expect(primary, 'no part was densified — the monotone check would be vacuous').toBeDefined()
    for (let i = 0; i < primary!.length - 1; i++) {
      expect(Math.abs(primary![i + 1][0] - primary![i][0])).toBeLessThan(180)
    }
  })

  it('stays on the authored line over a long high-latitude edge', () => {
    // The REVERSE of what this file asserted until #1522, and the whole of that
    // change's semantics in one assertion. A 160° great-circle arc between two
    // 84°N endpoints bulges to ~88.95°N at its midpoint — measured, and exactly
    // where the old geodesic densifier put its vertices. Densification adds
    // vertices ON the authored line; it does not relocate the line, so every
    // inserted vertex holds the endpoints' latitude and only longitude advances.
    const parts = lineParts([
      [-170, 84],
      [-10, 84],
    ])
    const all = parts.flat()
    // Non-vacuity: subdivision must have fired, or there are no interpolated
    // vertices for the latitude check to be about. (17 sub-segments — the
    // parallel is 160·cos(84) = 16.7° long, which is the span that governs
    // here; the great circle between the same two points runs over the pole
    // and is only 11.8°.)
    expect(all.length).toBeGreaterThan(10)
    for (const [, lat] of all) expect(lat).toBeCloseTo(84, 12)
  })
})

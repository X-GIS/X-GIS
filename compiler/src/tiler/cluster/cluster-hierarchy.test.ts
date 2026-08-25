// The hierarchy-build semantics of the cluster index (#2050, design §2), one separable
// mechanism per `describe`. Per CLAUDE.md §12 each block is written so that CUTTING ITS
// OWN MECHANISM turns it red while the others stay green — "the clusters look right"
// would survive the centroid weighting being removed, the radius scale being dropped, and
// the else-branch neighbour marking being deleted.
//
// All fixtures sit on the equator or at lat 20 and away from tile boundaries, so a
// failure is about clustering, never about which tile a point landed in.

import { describe, expect, it } from 'vitest'
import type { GeoJSONFeature } from '../geojson-types'
import type { GeoJSONInput, TransformedTile } from '../geojsonvt/types'
import { PointCluster } from './index'
import { CLUSTER_TAG } from './types'

function pt(lon: number, lat: number, properties: Record<string, unknown> = {}): GeoJSONFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties }
}
function fc(features: GeoJSONFeature[]): GeoJSONInput {
  return { type: 'FeatureCollection', features }
}
/** `point_count` per emitted feature, `null` where the feature is an individual point. */
function counts(tile: TransformedTile | null): (number | null)[] {
  if (tile === null) return []
  return tile.features.map((f) => (f.tags?.[CLUSTER_TAG.count] as number | undefined) ?? null)
}

// A pair `sep` degrees of longitude apart, centred on the prime meridian at lat 0.
function pair(sep: number): GeoJSONInput {
  return fc([pt(-sep / 2, 0), pt(sep / 2, 0)])
}
/** Does the pair collapse into one aggregate at z0? */
function pairClusters(sep: number, options = {}): boolean {
  const tile = new PointCluster(pair(sep), { maxZoom: 0, ...options }).getTile(0, 0, 0)
  return counts(tile).some((c) => c !== null)
}

describe('cluster hierarchy: the radius is scaled px → extent units, ×16 at extent 8192', () => {
  // r(z0) = 800 / 8192 = 0.09765625 of the unit square = 35.15625° of longitude.
  // Without the ×16 it would be 50 / 8192 = 0.006103515625 = 2.197°.
  it('clusters a 30° pair — inside the scaled radius, far outside the unscaled one', () => {
    expect(pairClusters(30)).toBe(true)
  })

  it('EXACTLY at the radius still clusters (the neighbourhood test is closed)', () => {
    expect(pairClusters(35.15625)).toBe(true)
  })

  it('a hair past it does not', () => {
    expect(pairClusters(35.16)).toBe(false)
  })

  it('a 2° pair clusters EITHER WAY — so a red above is about the SCALE, not clustering', () => {
    // The control arm. 2° is inside the unscaled radius too, so dropping the ×16 leaves
    // this one green; only a genuinely broken index turns it red.
    expect(pairClusters(2)).toBe(true)
  })
})

describe('cluster hierarchy: the radius halves per zoom (r = radiusExtent / (extent · 2^z))', () => {
  // Two points 7.2° apart (Δx = 0.02) at lon −15 / −7.8, lat 20 — inside one tile at
  // every zoom asserted below. r(z) = 0.09765625 / 2^z, so they merge while 2^z ≤ 4.88,
  // i.e. at z ≤ 2 and never at z ≥ 3.
  const ladder = () => new PointCluster(fc([pt(-15, 20), pt(-7.8, 20)]), { maxZoom: 4 })

  it.each([
    [4, 7, 7],
    [3, 3, 3],
  ])('stays two individual points at z=%s (radius already smaller than the gap)', (z, x, y) => {
    expect(counts(ladder().getTile(z, x, y))).toEqual([null, null])
  })

  it.each([
    [2, 1, 1],
    [1, 0, 0],
    [0, 0, 0],
  ])('collapses to one aggregate of 2 at z=%s', (z, x, y) => {
    expect(counts(ladder().getTile(z, x, y))).toEqual([2])
  })
})

describe('cluster hierarchy: above clusterMaxZoom the RAW level is served (#2050 §7)', () => {
  // Distinct from the radius ladder above: here the tile zooms are past `maxZoom`
  // entirely, so the level chosen — not the radius — decides. A style's unclustered
  // layer depends on this: past the knob a clustered source shows INDIVIDUAL points.
  const index = () => new PointCluster(fc([pt(-15, 20), pt(-7.8, 20)]), { maxZoom: 2 })

  it('serves the aggregate at clusterMaxZoom itself', () => {
    expect(counts(index().getTile(2, 1, 1))).toEqual([2])
  })

  it.each([
    [3, 3, 3],
    [4, 7, 7],
  ])('serves individual points at z=%s, above it', (z, x, y) => {
    expect(counts(index().getTile(z, x, y))).toEqual([null, null])
  })
})

describe('cluster hierarchy: the centroid is weighted by child point counts (#2050 §2)', () => {
  // P1/P2/P3 at x = 0.40 / 0.41 / 0.42 merge at z1 into an aggregate of 3 at x = 0.41;
  // P4 at x = 0.47 is outside r(z1) = 0.0488 and joins only at z0, r = 0.09765625.
  //   weighted: (0.41·3 + 0.47·1) / 4 = 0.425  → 8192 · 0.425 = 3481.6 → 3482
  //   arithmetic mean of the two RECORDS: (0.41 + 0.47) / 2 = 0.44 → 3604
  // 122 extent units apart, so the two hypotheses are not confusable.
  const index = new PointCluster(fc([pt(-36, 0), pt(-32.4, 0), pt(-28.8, 0), pt(-10.8, 0)]), {
    maxZoom: 1,
  })
  const tile = index.getTile(0, 0, 0) as TransformedTile

  it('merges all four into one aggregate at z0', () => {
    expect(counts(tile)).toEqual([4])
  })

  it('lands the aggregate next to the HEAVY child, not midway between the two records', () => {
    const [x] = (tile.features[0].geometry as [number, number][])[0]
    expect(x).toBe(3482)
    expect(x).not.toBe(3604)
  })
})

describe('cluster hierarchy: the minPoints admission rule (#2050 §2)', () => {
  it('a pair does not reach minPoints 3', () => {
    expect(pairClusters(30, { minPoints: 3 })).toBe(false)
  })

  it('the same pair clusters at the default minPoints 2 — the cut is minPoints, not geometry', () => {
    expect(pairClusters(30)).toBe(true)
  })

  it('a FRACTIONAL minPoints 2.4 rejects 2 and admits 3 — `>=`, unrounded', () => {
    const three = new PointCluster(fc([pt(-4, 0), pt(0, 0), pt(4, 0)]), {
      maxZoom: 0,
      minPoints: 2.4,
    })
    expect(counts(three.getTile(0, 0, 0))).toEqual([3])
    expect(pairClusters(8, { minPoints: 2.4 })).toBe(false)
  })

  it('a below-minPoints neighbourhood CONSUMES its neighbours — no second seed at this zoom', () => {
    // The else-branch's marking loop (design §2: "the else-branch _also_ marks neighbours
    // processed"). A at lon −40, B at −10, C at 10, D at 20, minPoints 3, r(z0) = 35.156°:
    //   A~B (30°) but A≁C (50°) and A≁D (60°); B~C (20°), B~D (30°), C~D (10°).
    // Reference: A seeds, finds {A,B} = 2 < 3 → passes through AND consumes B. C then
    // seeds, finds {B,C,D} with B already consumed → 2 < 3 → passes through, consumes D.
    // Four individual points.
    // Without the marking, B is still unconsumed when it becomes a seed: {B,C,D} = 3 ≥ 3
    // and an aggregate of THREE appears that the reference never forms.
    const index = new PointCluster(fc([pt(-40, 0), pt(-10, 0), pt(10, 0), pt(20, 0)]), {
      maxZoom: 0,
      minPoints: 3,
    })
    expect(counts(index.getTile(0, 0, 0))).toEqual([null, null, null, null])
  })
})

describe('cluster hierarchy: input acceptance is Point / MultiPoint only (#2050 §4.6)', () => {
  const mixed = fc([
    pt(-2, 0, { kind: 'point' }),
    pt(2, 0, { kind: 'point' }),
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [100, 40],
          [101, 41],
        ],
      },
      properties: { kind: 'line' },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 10],
          ],
        ],
      },
      properties: { kind: 'polygon' },
    },
    { type: 'Feature', geometry: null, properties: { kind: 'unlocated' } },
  ])

  it('counts every feature that contributed no indexed point', () => {
    expect(new PointCluster(mixed, { maxZoom: 0 }).skippedFeatureCount).toBe(3)
  })

  it('indexes NONE of them — upstream would place a LineString at coordinates[0]', () => {
    // Reproducing upstream's garbage position "for compatibility" would be shipping a bug
    // on purpose (§4.6). The two real points still cluster, so a red here is about the
    // skipped features, not about the index failing to run.
    const tile = new PointCluster(mixed, { maxZoom: 0 }).getTile(0, 0, 0) as TransformedTile
    expect(counts(tile)).toEqual([2])
    expect(JSON.stringify(tile.features)).not.toContain('line')
    expect(JSON.stringify(tile.features)).not.toContain('polygon')
  })

  it('expands a MultiPoint per coordinate, sharing the parent feature’s properties', () => {
    const index = new PointCluster(
      fc([
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [-4, 0],
              [0, 0],
              [4, 0],
            ],
          },
          properties: { kind: 'multi' },
        },
      ]),
      { maxZoom: 0, minPoints: 3 },
    )
    expect(index.skippedFeatureCount).toBe(0)
    expect(counts(index.getTile(0, 0, 0))).toEqual([3])
  })
})

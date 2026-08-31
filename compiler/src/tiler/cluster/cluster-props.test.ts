// `clusterProperties` aggregation (#2050, design §2's map/reduce bullet and §4.3's
// "travel as xgis expression ASTs, evaluated by evaluate()").
//
// The reduce has THREE independently-wrong-able halves and each gets its own witness,
// because they all fail as "the sum is wrong" and a single expected number would not say
// which: the `accumulated` reserved-key injection, the incoming-mapped-bag operand, and
// the seed being the ORIGIN's own mapped bag. The fixture is chosen so the three wrong
// hypotheses produce three DIFFERENT numbers (4.0 / 4.5 / 6.5) and none of them is the
// right one (8.0) — a red therefore names the half.

import { describe, expect, it } from 'vitest'
import { parseExpressionString } from '../../parser/parser'
import type { ClusterProperty } from '../../ir/source-cluster'
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
/** The `.xgis` spelling design §4.3 settled on, parsed the way `lowerSourceCluster` hands
 *  it over: a pair of `AST.Expr`, never folded values. */
function prop(map: string, reduce: string): ClusterProperty {
  return { map: parseExpressionString(map), reduce: parseExpressionString(reduce) }
}
function soleFeatureTags(tile: TransformedTile | null): Record<string, unknown> {
  expect(tile).not.toBeNull()
  const t = tile as TransformedTile
  expect(t.features).toHaveLength(1)
  return t.features[0].tags as Record<string, unknown>
}

describe('clusterProperties: the map/reduce pair aggregates over a cluster', () => {
  //   mags 1.5 / 2.5 / 4.0, all inside r(z0)
  //   correct                       : seed 1.5, +2.5 → 4.0, +4.0 → 8.0
  //   `accumulated` never injected  : 0+2.5 → 2.5, 0+4.0 → 4.0
  //   reduce reading the ORIGIN bag : 1.5+1.5 → 3.0, 3.0+1.5 → 4.5
  //   accumulator seeded from {}    : 0+2.5 → 2.5, 2.5+4.0 → 6.5
  const index = () =>
    new PointCluster(fc([pt(-4, 0, { mag: 1.5 }), pt(0, 0, { mag: 2.5 }), pt(4, 0, { mag: 4 })]), {
      maxZoom: 0,
      clusterProperties: { magSum: prop('.mag', 'accumulated + .magSum') },
    })

  it('sums every member exactly once, seeded from the origin', () => {
    const tags = soleFeatureTags(index().getTile(0, 0, 0))
    expect(tags[CLUSTER_TAG.count]).toBe(3)
    expect(tags.magSum).toBe(8)
    // The three wrong hypotheses, named so a red says which half moved.
    expect(tags.magSum).not.toBe(4) // `accumulated` not injected
    expect(tags.magSum).not.toBe(4.5) // reduce read the origin's bag, not the incoming one
    expect(tags.magSum).not.toBe(6.5) // accumulator seeded empty instead of from the origin
  })

  it('`map` PROJECTS — a source property the style did not declare never reaches the cluster', () => {
    const withNoise = new PointCluster(
      fc([pt(-4, 0, { mag: 1.5, name: 'alpha' }), pt(4, 0, { mag: 2.5, name: 'beta' })]),
      { maxZoom: 0, clusterProperties: { magSum: prop('.mag', 'accumulated + .magSum') } },
    )
    const tags = soleFeatureTags(withNoise.getTile(0, 0, 0))
    expect(tags.magSum).toBe(4)
    expect(tags).not.toHaveProperty('name')
  })
})

describe('clusterProperties: an aggregate merging into a bigger aggregate REUSES its value', () => {
  // P1/P2/P3 (mags 1/2/3) merge at z1; P4 (mag 10) is outside r(z1) and joins at z0. The
  // z0 merge must seed from the STORED aggregate 6, not re-map the origin record — whose
  // `id` column holds a cluster_id, not an index into the retained points, so re-mapping
  // it reads nothing at all and the total collapses to 10.
  const index = new PointCluster(
    fc([
      pt(-36, 0, { mag: 1 }),
      pt(-32.4, 0, { mag: 2 }),
      pt(-28.8, 0, { mag: 3 }),
      pt(-10.8, 0, { mag: 10 }),
    ]),
    { maxZoom: 1, clusterProperties: { magSum: prop('.mag', 'accumulated + .magSum') } },
  )

  it('aggregates the first three at z1', () => {
    const tile = index.getTile(1, 0, 0) as TransformedTile
    expect(tile.features).toHaveLength(2)
    const aggregate = tile.features.find((f) => f.tags?.[CLUSTER_TAG.count] === 3)
    expect(aggregate?.tags?.magSum).toBe(6)
  })

  it('folds that aggregate plus the latecomer at z0 — 6 + 10, not 10', () => {
    const tags = soleFeatureTags(index.getTile(0, 0, 0))
    expect(tags[CLUSTER_TAG.count]).toBe(4)
    expect(tags.magSum).toBe(16)
    expect(tags.magSum).not.toBe(10) // the stored aggregate was re-mapped instead of reused
  })
})

describe('clusterProperties: the synthetic four are authoritative', () => {
  it('a cluster with no declared properties carries exactly the four', () => {
    const index = new PointCluster(fc([pt(-2, 0), pt(2, 0)]), { maxZoom: 0 })
    const tags = soleFeatureTags(index.getTile(0, 0, 0))
    expect(Object.keys(tags).sort()).toEqual(
      [CLUSTER_TAG.isCluster, CLUSTER_TAG.id, CLUSTER_TAG.count, CLUSTER_TAG.abbreviated].sort(),
    )
    expect(tags[CLUSTER_TAG.isCluster]).toBe(true)
  })

  it('a declared key named `point_count` cannot shadow the real count', () => {
    // Every canonical clustering style filters on `point_count`; an aggregation key of the
    // same name winning would break the filter silently.
    const index = new PointCluster(fc([pt(-2, 0), pt(2, 0)]), {
      maxZoom: 0,
      clusterProperties: { point_count: prop('0', 'accumulated + 1') },
    })
    expect(soleFeatureTags(index.getTile(0, 0, 0))[CLUSTER_TAG.count]).toBe(2)
  })

  it('an INDIVIDUAL point keeps its own properties and gains none of the four', () => {
    const index = new PointCluster(fc([pt(0, 0, { name: 'lonely' })]), { maxZoom: 0 })
    const tags = soleFeatureTags(index.getTile(0, 0, 0))
    expect(tags).toEqual({ name: 'lonely' })
  })

  it('carries point_count_abbreviated with the TYPE the reference produces', () => {
    const many = fc(Array.from({ length: 1000 }, (_, i) => pt(-0.05 + i * 0.0001, 0)))
    const bigTags = soleFeatureTags(new PointCluster(many, { maxZoom: 0 }).getTile(0, 0, 0))
    expect(bigTags[CLUSTER_TAG.count]).toBe(1000)
    expect(bigTags[CLUSTER_TAG.abbreviated]).toBe('1k')

    const fewTags = soleFeatureTags(
      new PointCluster(fc([pt(-2, 0), pt(0, 0), pt(2, 0)]), { maxZoom: 0 }).getTile(0, 0, 0),
    )
    expect(fewTags[CLUSTER_TAG.abbreviated]).toBe(3)
    expect(typeof fewTags[CLUSTER_TAG.abbreviated]).toBe('number')
  })

  it('the cluster_id tag is the packed, decodable id — and is also the feature id', () => {
    const index = new PointCluster(fc([pt(-2, 0), pt(2, 0)]), { maxZoom: 0 })
    const tile = index.getTile(0, 0, 0) as TransformedTile
    const tags = tile.features[0].tags as Record<string, unknown>
    const clusterId = tags[CLUSTER_TAG.id] as number
    expect(tile.features[0].id).toBe(clusterId)
    // Two points, origin record 0, formed at zoom 0 → (0 << 5) + (0 + 1) + 2.
    expect(clusterId).toBe(3)
    expect((clusterId - 2) >> 5).toBe(0)
    expect(((clusterId - 2) % 32) - 1).toBe(0)
  })
})

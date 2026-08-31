// `PointCluster.getTile` — the query half (#2050, design §2's "tile query" bullet). The
// four mechanisms here are separable and are cut separately: the empty-tile `null`, the
// drift-free emit of an individual point, and each of the TWO antimeridian arms.

import { describe, expect, it } from 'vitest'
import type { GeoJSONFeature } from '../geojson-types'
import { projectX, projectY } from '../geojsonvt/convert'
import { encodeMVT } from '../geojsonvt/encode-mvt'
import { transformPoint } from '../geojsonvt/transform'
import type { GeoJSONInput, TransformedTile } from '../geojsonvt/types'
import { PointCluster } from './index'
import { CLUSTER_TAG } from './types'
import { dequantizeUnit, quantizeUnit } from './units'

const EXTENT = 8192

function pt(lon: number, lat: number, properties: Record<string, unknown> = {}): GeoJSONFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties }
}
function fc(features: GeoJSONFeature[]): GeoJSONInput {
  return { type: 'FeatureCollection', features }
}
function xsOf(tile: TransformedTile): number[] {
  return tile.features.map((f) => (f.geometry as [number, number][])[0][0]).sort((a, b) => a - b)
}

describe('getTile: an empty tile is null, not an empty tile', () => {
  it('returns null where nothing is in range', () => {
    // Same contract `GeoJSONVT.getTile` has, so the P3 router can treat the two indexes
    // identically instead of learning a second emptiness convention.
    const index = new PointCluster(fc([pt(0, 0)]), { maxZoom: 4 })
    expect(index.getTile(2, 0, 0)).toBeNull()
  })

  it('is not null where something IS in range — the emptiness check is not blanket', () => {
    const index = new PointCluster(fc([pt(0, 0)]), { maxZoom: 4 })
    expect(index.getTile(2, 2, 2)).not.toBeNull()
  })

  it('an EMPTY source answers null everywhere instead of throwing', () => {
    // A source whose data has not arrived, or arrived empty, is an ordinary state, not an
    // error — every level, tree and query has to survive n = 0.
    const index = new PointCluster(fc([]), { maxZoom: 2 })
    expect(index.skippedFeatureCount).toBe(0)
    expect(index.getTile(0, 0, 0)).toBeNull()
    expect(index.getTile(3, 4, 4)).toBeNull()
  })
})

describe('getTile: the zoom window mirrors GeoJSONVT.getTile’s', () => {
  const index = () => new PointCluster(fc([pt(0, 0)]), { maxZoom: 2 })

  it('rejects a zoom outside 0…25 — the ceiling the sibling index also enforces', () => {
    // (2^25, 2^25) is the tile that WOULD hold the point at z=26; asking for (0, 0) there
    // would be null with or without the ceiling and would prove nothing about it.
    expect(index().getTile(-1, 0, 0)).toBeNull()
    expect(index().getTile(26, 2 ** 25, 2 ** 25)).toBeNull()
  })

  it('ACCEPTS z=25 — the rejection above is the ceiling, not a blanket refusal', () => {
    expect(index().getTile(25, 2 ** 24, 2 ** 24)).not.toBeNull()
    expect(index().getTile(25, 0, 0)).toBeNull()
  })
})

describe('getTile: an individual point is emitted DRIFT-FREE (#2050 §2)', () => {
  // Design §2: single points come from the retained Float64 projections, never from the
  // Int32 store, whose half-step is ~1.9 cm at the equator. At a deep zoom the difference
  // is several extent units and therefore checkable; at z0 it would round away, which is
  // precisely what makes it a silent divergence in the field.
  const LON = 100 / 3
  const LAT = 20
  const Z = 22

  const px = projectX(LON)
  const py = projectY(LAT)
  const z2 = 2 ** Z
  const tx = Math.floor(px * z2)
  const ty = Math.floor(py * z2)

  it('the fixture actually discriminates — the quantized round trip lands elsewhere', () => {
    // Guards the witness itself: if this longitude ever stopped being lossy at this zoom,
    // the assertion below would pass for both hypotheses and prove nothing.
    const fromQuantized = transformPoint(
      dequantizeUnit(quantizeUnit(px)),
      dequantizeUnit(quantizeUnit(py)),
      EXTENT,
      z2,
      tx,
      ty,
    )
    const fromFloat64 = transformPoint(px, py, EXTENT, z2, tx, ty)
    expect(fromQuantized[0]).not.toBe(fromFloat64[0])
  })

  it('emits the Float64 coordinate, not the Int32 round trip', () => {
    const index = new PointCluster(fc([pt(LON, LAT)]), { maxZoom: 14 })
    const tile = index.getTile(Z, tx, ty) as TransformedTile
    expect(tile.features).toHaveLength(1)
    expect((tile.features[0].geometry as [number, number][])[0]).toEqual(
      transformPoint(px, py, EXTENT, z2, tx, ty),
    )
  })
})

describe('getTile: the two antimeridian wrap arms (#2050 §2)', () => {
  // One point just west of the antimeridian (lon 170) and one just east (lon −170), at
  // z1 where the world is two tiles. Neither pairs with the other — the clustering pass
  // does not wrap, upstream's behaviour — so each tile sees exactly one in-tile point and
  // one wrapped copy in its buffer.
  //
  //   tile (1,0,0): lon −170 in-tile at +455, lon 170 arriving through the x === 0 arm at
  //                 −455 (negative = the LEFT buffer).
  //   tile (1,1,0): lon 170 in-tile at 7737, lon −170 through the x === z2−1 arm at 8647
  //                 (past the 8192 extent = the RIGHT buffer).
  const index = () => new PointCluster(fc([pt(170, 20), pt(-170, 20)]), { maxZoom: 4 })

  it('the x === 0 arm brings the world’s east edge into the leftmost tile', () => {
    const tile = index().getTile(1, 0, 0) as TransformedTile
    expect(xsOf(tile)).toEqual([-455, 455])
  })

  it('the x === z2−1 arm brings the world’s west edge into the rightmost tile', () => {
    const tile = index().getTile(1, 1, 0) as TransformedTile
    expect(xsOf(tile)).toEqual([7737, 8647])
  })

  it('a MIDDLE tile grows no arms — the wrap is edge-only, not a blanket duplication', () => {
    // Control arm: at z2 = 4 the two edge tiles still wrap and the inner ones must not.
    const tile = index().getTile(2, 1, 1)
    expect(tile).toBeNull()
  })
})

describe('getTile: x wraps around the antimeridian, as GeoJSONVT.getTile does', () => {
  it('an out-of-range tile x resolves to its wrapped twin', () => {
    // The two indexes answer for ONE source; a viewport asking for x = −1 must not get a
    // tile from one and null from the other.
    const index = new PointCluster(fc([pt(170, 20), pt(-170, 20)]), { maxZoom: 4 })
    const wrapped = index.getTile(1, -1, 0) as TransformedTile
    const direct = index.getTile(1, 1, 0) as TransformedTile
    expect(xsOf(wrapped)).toEqual(xsOf(direct))
  })
})

describe('getTile: the emitted tile is what encodeMVT already consumes (#2050 §1)', () => {
  const index = new PointCluster(fc([pt(-2, 0), pt(2, 0)]), { maxZoom: 0 })
  const tile = index.getTile(0, 0, 0) as TransformedTile

  it('is a TransformedTile: type-1 features, transformed, addressed at the requested tile', () => {
    expect(tile.transformed).toBe(true)
    expect(tile.z).toBe(0)
    expect(tile.numFeatures).toBe(tile.features.length)
    expect(tile.features.every((f) => f.type === 1)).toBe(true)
    expect(tile.features[0].tags?.[CLUSTER_TAG.count]).toBe(2)
  })

  it('encodes to MVT bytes carrying the synthetic property KEYS', () => {
    // Design §1: `encodeMVT` accepts exactly the shape this index produces, and once
    // `point_count` is a tag it reaches expressions through the ordinary MVT property
    // table. The key strings land in the layer's key table verbatim, so their presence in
    // the bytes is a structural check that does not need a decoder in this package.
    const bytes = encodeMVT([{ name: 'quakes', tile }], { extent: EXTENT })
    expect(bytes.length).toBeGreaterThan(0)
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).toContain(CLUSTER_TAG.count)
    expect(text).toContain(CLUSTER_TAG.abbreviated)
    expect(text).toContain(CLUSTER_TAG.id)
  })
})

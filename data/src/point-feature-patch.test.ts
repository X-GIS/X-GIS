// ═══ In-place point-feature patch — the data half (#1375) ═══
//
// Fail-before: `planPointFeaturePatch` / `applyPointFeaturePatch` /
// `buildPointFeatureIds` / `TileCatalog.patchPointFeatures` do not exist on
// pre-fix code, and neither does `TileData.pointFeatureIds` — a host feature
// update had no route that did not re-tile the source.
//
// What each block is guarding:
//  · the side-car resolves ids through the packed `fid` SLOT, not through the
//    record's ordinal. Pre-#1375 nothing keyed points by a stable id at all, so
//    the tempting shape is `ids[k] = features[k].id`; the fixture below orders
//    the records against the feature array precisely so that shape fails.
//  · the patch writes THROUGH the `pointVertices` view. Production hands out
//    whole buffers today, but a sub-tile clip and the arena paths hand out
//    windows — and `new Float32Array(pv.buffer)` reads identically to the
//    correct code when `byteOffset` is 0 (2026-08-14, "every test passed offset
//    zero"). The fixture is a window with live neighbours on both sides.
//  · every rejection path leaves the buffers BYTE-IDENTICAL, because the whole
//    contract with the caller is "false means nothing happened, take the
//    re-seed".

import { describe, it, expect } from 'vitest'
import { lonLatToMercF64, packECEFPointFeatures, tileKey } from '@xgis/compiler'
import {
  applyPointFeaturePatch,
  buildPointFeatureIds,
  planPointFeaturePatch,
  POINT_VERTEX_STRIDE as S,
} from './point-feature-patch'
import { TileCatalog } from './tile-catalog'
import type { TileData } from './tile-types'

/** Pack `[lon, lat, fid]` triples the way the tiler does, so the fixture's
 *  bytes are the real layout rather than a hand-written imitation. */
function packPoints(pts: readonly [number, number, number][]): Float32Array {
  const scratch: number[] = []
  for (const [lon, lat, fid] of pts) {
    const [mx, my] = lonLatToMercF64(lon, lat)
    scratch.push(mx, my, fid)
  }
  return packECEFPointFeatures(scratch)
}

/** A minimal TileData carrying only what the patch reads. Tile bounds are the
 *  z2/x2/y1 tile: lon [0, 90], lat [0, 66.51]. */
function tile(points: Float32Array, ids: Uint32Array | undefined): TileData {
  const empty = new Float32Array(0)
  const emptyI = new Uint32Array(0)
  return {
    vertices: empty,
    dequantScale: 1,
    dequantHalf: 0,
    indices: emptyI,
    lineVertices: empty,
    lineIndices: emptyI,
    outlineIndices: emptyI,
    pointVertices: points,
    pointFeatureIds: ids,
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 90,
    tileHeight: 66.51,
    tileZoom: 2,
  }
}

describe('buildPointFeatureIds (#1375)', () => {
  it('resolves each id through the packed fid SLOT, not the record ordinal', () => {
    // Records are packed in the order (feature 2, feature 0) — the tiler emits
    // points in part order, which is NOT the source-feature order once a tile
    // holds a subset. An `ids[k] = features[k].id` implementation returns
    // [70, 90] here; the correct one returns [90, 70].
    const points = packPoints([
      [10, 10, 2],
      [20, 20, 0],
    ])
    const ids = buildPointFeatureIds([{ id: 70 }, { id: 80 }, { id: 90 }], points)
    expect(Array.from(ids!)).toEqual([90, 70])
  })

  it('returns undefined when no packed point resolves a usable id', () => {
    const points = packPoints([[10, 10, 0]])
    expect(buildPointFeatureIds([{}], points)).toBeUndefined()
    expect(buildPointFeatureIds([{ id: 'ship-A' }], points)).toBeUndefined()
    expect(buildPointFeatureIds([{ id: 0 }], points)).toBeUndefined()
  })

  it('returns undefined for a slice with no packed points', () => {
    expect(buildPointFeatureIds([{ id: 7 }], undefined)).toBeUndefined()
    expect(buildPointFeatureIds([{ id: 7 }], new Float32Array(0))).toBeUndefined()
  })
})

describe('planPointFeaturePatch + applyPointFeaturePatch (#1375)', () => {
  /** The production-shaped fixture: `pointVertices` is a WINDOW into a larger
   *  buffer with live neighbour records on both sides. */
  function windowedFixture(): {
    backing: Float32Array
    data: TileData
    before: Float32Array
  } {
    const backing = new Float32Array(S * 3)
    backing.fill(-999) // decoy: neighbours that must survive the patch untouched
    const view = backing.subarray(S, S * 2)
    view.set(packPoints([[10, 10, 4]]))
    return { backing, data: tile(view, Uint32Array.of(4242)), before: backing.slice() }
  }

  it('rewrites ONLY the matched record, through the view, and preserves its fid', () => {
    const { backing, data } = windowedFixture()
    const plan = planPointFeaturePatch([data], [{ featureId: 4242, lon: 30, lat: 40 }])
    expect(plan).not.toBeNull()
    applyPointFeaturePatch(plan!)

    // The patched bytes are byte-for-byte what the tiler would have packed for
    // the new position — the packing keeps exactly one authority.
    expect(Array.from(data.pointVertices!)).toEqual(Array.from(packPoints([[30, 40, 4]])))
    // The `fid` slot (index 6) is the per-slice feature INDEX that featureProps
    // / heights / bases are keyed by — a patch must never renumber it.
    expect(data.pointVertices![6]).toBe(4)
    // Neighbours on BOTH sides of the window are untouched. A `new
    // Float32Array(pv.buffer)` implementation writes record 0 here instead.
    expect(Array.from(backing.subarray(0, S))).toEqual(new Array(S).fill(-999))
    expect(Array.from(backing.subarray(S * 2))).toEqual(new Array(S).fill(-999))
  })

  it('patches EVERY resident slice that holds the feature (all zoom levels)', () => {
    const z0 = tile(packPoints([[10, 10, 0]]), Uint32Array.of(7))
    z0.tileWest = -180
    z0.tileSouth = -85
    z0.tileWidth = 360
    z0.tileHeight = 170
    z0.tileZoom = 0
    const z2 = tile(packPoints([[10, 10, 0]]), Uint32Array.of(7))
    const plan = planPointFeaturePatch([z0, z2], [{ featureId: 7, lon: 11, lat: 12 }])
    expect(plan).not.toBeNull()
    applyPointFeaturePatch(plan!)
    const expected = Array.from(packPoints([[11, 12, 0]]))
    expect(Array.from(z0.pointVertices!)).toEqual(expected)
    expect(Array.from(z2.pointVertices!)).toEqual(expected)
  })

  it('REJECTS a move that leaves the tile — that is a re-tile, not a patch', () => {
    const { backing, data, before } = windowedFixture()
    // lon 120 is east of this tile's [0, 90]; the feature now belongs to a
    // different tile, which no in-place rewrite can express.
    expect(planPointFeaturePatch([data], [{ featureId: 4242, lon: 120, lat: 40 }])).toBeNull()
    expect(Array.from(backing)).toEqual(Array.from(before))
  })

  it('REJECTS an id that appears twice in one slice (a MultiPoint feature)', () => {
    const data = tile(
      packPoints([
        [10, 10, 0],
        [20, 20, 0],
      ]),
      Uint32Array.of(5, 5),
    )
    expect(planPointFeaturePatch([data], [{ featureId: 5, lon: 30, lat: 30 }])).toBeNull()
  })

  it('REJECTS a side-car whose length disagrees with the packed point count', () => {
    const data = tile(
      packPoints([
        [10, 10, 0],
        [20, 20, 1],
      ]),
      Uint32Array.of(5),
    )
    expect(planPointFeaturePatch([data], [{ featureId: 5, lon: 30, lat: 30 }])).toBeNull()
  })

  it('REJECTS the id-0 sentinel and a non-finite destination', () => {
    const data = tile(packPoints([[10, 10, 0]]), Uint32Array.of(0))
    expect(planPointFeaturePatch([data], [{ featureId: 0, lon: 30, lat: 30 }])).toBeNull()
    const ok = tile(packPoints([[10, 10, 0]]), Uint32Array.of(9))
    expect(planPointFeaturePatch([ok], [{ featureId: 9, lon: NaN, lat: 30 }])).toBeNull()
  })

  it('REJECTS when a move reaches no resident slice at all', () => {
    const data = tile(packPoints([[10, 10, 0]]), Uint32Array.of(9))
    expect(planPointFeaturePatch([data], [{ featureId: 1234, lon: 30, lat: 30 }])).toBeNull()
    // ALL-OR-NOTHING: one unreachable move rejects the whole batch, so a source
    // can never end up half-patched (z13 moved, z14 still stale).
    expect(
      planPointFeaturePatch(
        [data],
        [
          { featureId: 9, lon: 30, lat: 30 },
          { featureId: 1234, lon: 30, lat: 30 },
        ],
      ),
    ).toBeNull()
  })

  it('REJECTS a slice with no side-car (an MVT archive carrying no feature ids)', () => {
    const data = tile(packPoints([[10, 10, 0]]), undefined)
    expect(planPointFeaturePatch([data], [{ featureId: 9, lon: 30, lat: 30 }])).toBeNull()
  })
})

describe('TileCatalog.patchPointFeatures (#1375)', () => {
  /** Same escape hatch tile-catalog-content-generation.test.ts uses: drive the
   *  real backend-result path so the cached TileData is the one production
   *  builds (tile bounds included). */
  function accept(catalog: TileCatalog, key: number, result: unknown): void {
    ;(
      catalog as unknown as {
        acceptResult(key: number, result: unknown, sourceLayer?: string): void
      }
    ).acceptResult(key, result, 'pts')
  }

  function seed(catalog: TileCatalog, key: number, ids: Uint32Array): void {
    const empty = new Float32Array(0)
    const emptyI = new Uint32Array(0)
    accept(catalog, key, {
      vertices: empty,
      dequantScale: 1,
      dequantHalf: 0,
      indices: emptyI,
      lineVertices: empty,
      lineIndices: emptyI,
      pointVertices: packPoints([[10, 10, 0]]),
      pointFeatureIds: ids,
    })
  }

  it('rewrites the cached record and BUMPS contentGeneration', () => {
    const catalog = new TileCatalog()
    const key = tileKey(2, 2, 1) // lon [0, 90], lat [0, 66.51]
    seed(catalog, key, Uint32Array.of(77))
    const gen = catalog.contentGeneration()

    expect(catalog.patchPointFeatures([{ featureId: 77, lon: 20, lat: 30 }])).toBe(true)
    expect(Array.from(catalog.getTileData(key, 'pts')!.pointVertices!)).toEqual(
      Array.from(packPoints([[20, 30, 0]])),
    )
    // The bump is the whole redraw mechanism: TilePointPackKey.contentGeneration
    // (#1616) is the only field of that key a same-key content change moves, so
    // without it the point repack keeps its cached buffers and the patched
    // record never reaches the GPU.
    expect(catalog.contentGeneration(), 'a patched tile must be observable').not.toBe(gen)
  })

  it('returns false and changes NOTHING (contentGeneration included) on a reject', () => {
    const catalog = new TileCatalog()
    const key = tileKey(2, 2, 1)
    seed(catalog, key, Uint32Array.of(77))
    const gen = catalog.contentGeneration()
    const before = Array.from(catalog.getTileData(key, 'pts')!.pointVertices!)

    // Outside the tile's lon span → the caller must re-seed instead.
    expect(catalog.patchPointFeatures([{ featureId: 77, lon: 170, lat: 30 }])).toBe(false)
    expect(Array.from(catalog.getTileData(key, 'pts')!.pointVertices!)).toEqual(before)
    expect(
      catalog.contentGeneration(),
      'a rejected patch that still bumped would repack every point buffer for nothing',
    ).toBe(gen)
  })
})

// Issue #616 — one-way road arrows off the road centreline (OFM Bright,
// Seoul z22).
//
// forEachLineLabelPolyline walks `seen = neededKeys ∪ stableKeys` and emits
// one polyline per feature per tile. stableKeys folds in PARENT ancestor
// fallback keys (vector-tile-renderer.ts ~:3380-3390). So when a NEEDED
// descendant tile carries a feature at its fine geometry AND a coarser
// ANCESTOR tile (present in stableKeys as an eviction-protected /
// parent-fallback key) ALSO carries that feature, BOTH emit — the caller
// then samples an arrow anchor off the coarse ancestor stripe even though the
// GPU draws the fine descendant stripe. Result: the arrow sits beside the
// road, not on its centreline.
//
// The fix is an ancestry-aware suppression: an ancestor key's line emission is
// skipped when a strict DESCENDANT key present in `seen` already carries line
// data (that descendant is the finer, GPU-drawn source). The antimeridian
// world-copy siblings that motivated the neededKeys∪stableKeys walk
// (label-feature-source.ts:105-120, 2026-05-13 regression) are SAME-zoom, not
// ancestors of any needed key, so they must STILL be emitted.
//
// This is a pure CPU set-logic property — testable without a GPU. The visual
// on-screen arrow offset itself is NOT verified here (needs the mandated z22
// Seoul OFM Bright real-GPU directional pixel-diff).

import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import type { TileCatalog } from '@xgis/data'
import { LabelFeatureSource } from './label-feature-source'

// One horizontal segment (tile-local 0,0 → 100,0), stride-10 lineVertices,
// featId 0. featureProps tags the emission so the test can see WHICH tile
// produced each polyline.
function makeTileData(tag: string): unknown {
  const STRIDE = 10
  const lv = new Float64Array(STRIDE * 2)
  // vert0 @ (0,0), featId 0
  lv[4] = 0
  // vert1 @ (100,0), featId 0
  lv[STRIDE + 0] = 100
  lv[STRIDE + 4] = 0
  const li = new Uint32Array([0, 1])
  const featureProps = new Map<number, Record<string, unknown>>([[0, { tag }]])
  return { lineVertices: lv, lineIndices: li, tileWest: 0, tileSouth: 0, featureProps }
}

function makeSource(tiles: Map<number, string>): TileCatalog {
  return {
    getPropertyTable: () => undefined,
    getTileData: (key: number) => {
      const tag = tiles.get(key)
      return tag === undefined ? null : makeTileData(tag)
    },
  } as unknown as TileCatalog
}

function collectTags(
  src: LabelFeatureSource,
  source: TileCatalog,
  stableKeys: number[],
  neededKeys: number[],
): string[] {
  const tags: string[] = []
  src.beginFrame()
  src.forEachLineLabelPolyline(source, stableKeys, neededKeys, undefined, (_xs, _ys, props) => {
    tags.push(String((props as { tag: unknown }).tag))
  })
  return tags
}

describe('LabelFeatureSource.forEachLineLabelPolyline — ancestry-aware dedup (#616)', () => {
  // Seoul-ish z14 needed tile + its z12 ancestor.
  const D = tileKey(14, 14008, 6446)
  const A = tileKeyParent(tileKeyParent(D)) // strict z12 ancestor of D

  it('suppresses an ancestor-fallback key when a needed descendant carries line data', () => {
    const src = new LabelFeatureSource()
    const source = makeSource(
      new Map([
        [D, 'D'], // needed descendant, fine geometry — GPU-drawn source
        [A, 'A'], // ancestor fallback in stableKeys — coarse, redundant
      ]),
    )
    const tags = collectTags(src, source, [D, A], [D])
    // The fine descendant is emitted…
    expect(tags).toContain('D')
    // …and the coarse ancestor's redundant emission is suppressed.
    expect(tags).not.toContain('A')
  })

  it('still emits antimeridian world-copy siblings (not ancestors of any needed key)', () => {
    const src = new LabelFeatureSource()
    // S0/S1 are z1 world-copy siblings; neither is an ancestor of D (D's z1
    // ancestor is 1/1/0). They must NOT be suppressed — the 2026-05-13 guard.
    const S0 = tileKey(1, 0, 0)
    const S1 = tileKey(1, 0, 1)
    const source = makeSource(
      new Map([
        [D, 'D'],
        [S0, 'S0'],
        [S1, 'S1'],
      ]),
    )
    const tags = collectTags(src, source, [D, S0, S1], [D])
    expect(tags).toContain('D')
    expect(tags).toContain('S0')
    expect(tags).toContain('S1')
  })
})

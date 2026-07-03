// Regression: single-layer GeoJSON (sliceLayer='') empty deep-zoom
// tile must classify as drop-empty-slice, NOT be forced into
// queued-with-fallback / parent-fallback.
//
// The single-layer GeoJSON backend stores an EMPTY placeholder for
// tiles with no overlapping geometry (geojson-runtime-backend.ts:105
// -> tile-catalog acceptResult(key,null)). hasTileData(key,'') then
// returns true (slot.size>0), so on clean HEAD path-3 thisSliceCached
// fires and returns queued-with-fallback BEFORE the path-4 drop-empty
// branch -- whose `if (sliceLayer && ...)` guard can never run when
// sliceLayer=''. After the fix, the empty placeholder no longer
// satisfies path-3 (hasNonEmptySliceInCatalog=false) and the empty
// default slice reaches drop-empty.

import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import { classifyTile, type ClassifyTileInputs } from './tile-decision'

const tile = (z: number, x: number, y: number) => ({ z, x, y, ox: x })

describe('classifyTile — empty default-slice (single-layer GeoJSON)', () => {
  const visibleKey = tileKey(14, 8000, 5000)

  // Common scenario: single-layer GeoJSON, sliceLayer=''. The visible
  // tile has an EMPTY placeholder in the catalog (slice present but
  // zero geometry). No ancestor / child carries the slice. Not on GPU.
  const emptyDefaultSliceInputs = (
    overrides: Partial<ClassifyTileInputs> = {},
  ): ClassifyTileInputs =>
    ({
      visible: tile(14, 8000, 5000),
      visibleKey,
      maxLevel: 14,
      parentAtMaxLevel: -1,
      archiveAncestor: -1,
      layerCache: new Map<number, unknown>(), // not on GPU
      // The empty placeholder makes the slice "present" in the catalog.
      hasSliceInCatalog: (k) => k === visibleKey,
      // ...but it carries NO geometry — empty placeholder.
      hasNonEmptySliceInCatalog: () => false,
      // hasAnySliceInCatalog: only the (empty) default slice exists.
      hasAnySliceInCatalog: (k) => k === visibleKey,
      hasEntryInIndex: () => true,
      sliceLayer: '', // single-layer GeoJSON
      ...overrides,
    }) as ClassifyTileInputs

  it('empty default slice with no usable fallback → drop-empty-slice (NOT queued-with-fallback)', () => {
    const d = classifyTile(emptyDefaultSliceInputs())
    // Clean HEAD: path-3 thisSliceCached fires → queued-with-fallback.
    expect(d.kind).not.toBe('queued-with-fallback')
    expect(d.kind).toBe('drop-empty-slice')
  })

  it('empty default slice but ancestor HAS real geometry → parent-fallback (iter-284 parity for "" slice)', () => {
    const ancestorKey = tileKeyParent(visibleKey)
    const d = classifyTile(
      emptyDefaultSliceInputs({
        // visible slice present-but-empty; ancestor slice present AND
        // non-empty.
        hasSliceInCatalog: (k) => k === visibleKey || k === ancestorKey,
        hasNonEmptySliceInCatalog: (k) => k === ancestorKey,
        hasAnySliceInCatalog: (k) => k === visibleKey || k === ancestorKey,
      }),
    )
    expect(d.kind).toBe('parent-fallback')
    if (d.kind === 'parent-fallback') expect(d.parentKey).toBe(ancestorKey)
  })

  it('back-compat: NON-empty default slice still uploads (queued-with-fallback)', () => {
    const ancestorKey = tileKeyParent(visibleKey)
    const d = classifyTile(
      emptyDefaultSliceInputs({
        hasSliceInCatalog: (k) => k === visibleKey || k === ancestorKey,
        hasNonEmptySliceInCatalog: (k) => k === visibleKey || k === ancestorKey,
        hasAnySliceInCatalog: (k) => k === visibleKey || k === ancestorKey,
      }),
    )
    expect(d.kind).toBe('queued-with-fallback')
  })

  it('back-compat: hasNonEmptySliceInCatalog omitted defaults to hasSliceInCatalog (multi-layer untouched)', () => {
    // Multi-layer PMTiles: named slice present → treated as cached as
    // before, regardless of the new predicate (which is absent).
    const mlVisible = tileKey(8, 100, 50)
    const d = classifyTile({
      visible: tile(8, 100, 50),
      visibleKey: mlVisible,
      maxLevel: 14,
      parentAtMaxLevel: -1,
      archiveAncestor: -1,
      layerCache: new Map<number, unknown>(),
      hasSliceInCatalog: (k) => k === mlVisible,
      hasAnySliceInCatalog: () => false,
      hasEntryInIndex: () => true,
      sliceLayer: 'water',
    })
    expect(d.kind).toBe('queued-with-fallback')
  })
})

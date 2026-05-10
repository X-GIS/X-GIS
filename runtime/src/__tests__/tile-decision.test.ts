// Unit tests for classifyTile — the pure tile-resolution classifier
// extracted from VectorTileRenderer's per-tile loop. The point of
// having a pure function is to catch decision-logic bugs at the unit
// level instead of waiting for visual regressions to surface.

import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import { classifyTile, computeProtectedKeys, type ClassifyTileInputs, type TileDecision } from '../engine/tile-decision'

const tile = (z: number, x: number, y: number) => ({ z, x, y, ox: x })

const baseInputs = (overrides: Partial<ClassifyTileInputs> = {}): ClassifyTileInputs => {
  const layerCache = new Map<number, unknown>()
  return {
    visible: tile(8, 100, 50),
    visibleKey: tileKey(8, 100, 50),
    maxLevel: 14,
    parentAtMaxLevel: -1,
    archiveAncestor: -1,
    layerCache,
    hasSliceInCatalog: () => false,
    hasAnySliceInCatalog: () => false,
    hasEntryInIndex: () => true,
    sliceLayer: 'water',
    ...overrides,
  }
}

describe('classifyTile', () => {
  it('returns primary when visible is on GPU', () => {
    const visibleKey = tileKey(8, 100, 50)
    const layerCache = new Map<number, unknown>([[visibleKey, {}]])
    const d = classifyTile(baseInputs({ visibleKey, layerCache }))
    expect(d.kind).toBe('primary')
  })

  it('returns overzoom-parent when tileZ > maxLevel', () => {
    const visible = tile(16, 12345, 6789)
    const parentAtMaxLevel = tileKey(14, 3086, 1697)
    const d = classifyTile(baseInputs({
      visible,
      visibleKey: tileKey(visible.z, visible.x, visible.y),
      maxLevel: 14,
      parentAtMaxLevel,
    }))
    expect(d.kind).toBe('overzoom-parent')
    if (d.kind === 'overzoom-parent') {
      expect(d.parentKey).toBe(parentAtMaxLevel)
      expect(d.parentNeedsFetch).toBe(true)  // hasSliceInCatalog returns false
    }
  })

  it('overzoom-parent flags parentNeedsUpload when slice cached but not GPU', () => {
    const parentAtMaxLevel = 999
    const d = classifyTile(baseInputs({
      visible: tile(16, 0, 0),
      visibleKey: tileKey(16, 0, 0),
      parentAtMaxLevel,
      hasSliceInCatalog: (k) => k === parentAtMaxLevel,
    }))
    expect(d.kind).toBe('overzoom-parent')
    if (d.kind === 'overzoom-parent') {
      expect(d.parentNeedsFetch).toBe(false)
      expect(d.parentNeedsUpload).toBe(true)
    }
  })

  it('returns drop-empty-slice when this layer empty but tile loaded', () => {
    const visibleKey = tileKey(8, 100, 50)
    const d = classifyTile(baseInputs({
      visibleKey,
      hasSliceInCatalog: () => false,         // this layer empty
      hasAnySliceInCatalog: () => true,        // tile loaded for some other layer
    }))
    expect(d.kind).toBe('drop-empty-slice')
  })

  it('returns parent-fallback when ancestor cached', () => {
    const visibleKey = tileKey(8, 100, 50)
    const parentKey = tileKeyParent(visibleKey)  // z=7
    const d = classifyTile(baseInputs({
      visibleKey,
      hasSliceInCatalog: (k) => k === parentKey,
    }))
    expect(d.kind).toBe('parent-fallback')
    if (d.kind === 'parent-fallback') {
      expect(d.parentKey).toBe(parentKey)
      expect(d.parentNeedsUpload).toBe(true)
    }
  })

  it('returns child-fallback when no ancestor but children cached', () => {
    const visible = tile(8, 100, 50)
    const visibleKey = tileKey(visible.z, visible.x, visible.y)
    // z=9 children of (8, 100, 50)
    const childKeys = [
      tileKey(9, 200, 100), tileKey(9, 201, 100),
      tileKey(9, 200, 101), tileKey(9, 201, 101),
    ]
    const cachedChild = childKeys[0]
    const d = classifyTile(baseInputs({
      visible, visibleKey, maxLevel: 14,
      hasSliceInCatalog: (k) => k === cachedChild,
    }))
    expect(d.kind).toBe('child-fallback')
    if (d.kind === 'child-fallback') {
      expect(d.childKeys).toEqual([cachedChild])
      expect(d.childrenNeedingUpload).toEqual([cachedChild])
    }
  })

  it('returns drop-no-archive when no ancestor + no archive entry', () => {
    const d = classifyTile(baseInputs({
      visible: tile(5, 0, 0),
      visibleKey: tileKey(5, 0, 0),
      hasEntryInIndex: () => false,
      archiveAncestor: -1,
    }))
    expect(d.kind).toBe('drop-no-archive')
  })

  it('returns pending when nothing cached but archive has entry', () => {
    const visibleKey = tileKey(8, 100, 50)
    const d = classifyTile(baseInputs({
      visibleKey,
      hasEntryInIndex: () => true,
    }))
    expect(d.kind).toBe('pending')
    if (d.kind === 'pending') expect(d.requestKey).toBe(visibleKey)
  })

  it('returns pending with archive ancestor when visible not in index', () => {
    const visibleKey = tileKey(8, 100, 50)
    const archiveAncestor = tileKey(5, 12, 6)
    const d = classifyTile(baseInputs({
      visibleKey,
      hasEntryInIndex: (k) => k === archiveAncestor,
      archiveAncestor,
    }))
    expect(d.kind).toBe('pending')
    if (d.kind === 'pending') expect(d.requestKey).toBe(archiveAncestor)
  })

  it('queued-with-fallback wraps a fallback decision when slice in catalog', () => {
    const visibleKey = tileKey(8, 100, 50)
    const parentKey = tileKeyParent(visibleKey)
    const d = classifyTile(baseInputs({
      visibleKey,
      hasSliceInCatalog: (k) => k === visibleKey || k === parentKey,
    }))
    expect(d.kind).toBe('queued-with-fallback')
    if (d.kind === 'queued-with-fallback') {
      expect(d.uploadVisible).toBe(true)
      expect(d.fallback.kind).toBe('parent-fallback')
      if (d.fallback.kind === 'parent-fallback') {
        expect(d.fallback.parentKey).toBe(parentKey)
      }
    }
  })

  it('regression — commit 49d4801: queued visible falls through to walk', () => {
    // Pre-fix this scenario produced no fallback (uploadTile + continue
    // skipped the walk). The decision-classifier guarantees a fallback
    // is computed by structure.
    const visibleKey = tileKey(8, 100, 50)
    const parentKey = tileKeyParent(visibleKey)
    const d = classifyTile(baseInputs({
      visibleKey,
      hasSliceInCatalog: (k) => k === visibleKey || k === parentKey,
      // Visible NOT in layerCache (queued) — uploadVisible should fire
      // AND the fallback should be parent-fallback to keep the area
      // covered until the upload lands.
    }))
    expect(d.kind).toBe('queued-with-fallback')
    if (d.kind === 'queued-with-fallback') {
      expect(d.fallback.kind).toBe('parent-fallback')
    }
  })
})

describe('classifyTile — hasOtherSliceHeld coherence override', () => {
  it('hasOtherSliceHeld=false + GPU hit → primary (back-compat)', () => {
    const visibleKey = tileKey(8, 100, 50)
    const layerCache = new Map<number, unknown>([[visibleKey, {}]])
    const d = classifyTile(baseInputs({
      visibleKey, layerCache, hasOtherSliceHeld: false,
    }))
    expect(d.kind).toBe('primary')
  })

  it('hasOtherSliceHeld undefined + GPU hit → primary (default safe)', () => {
    const visibleKey = tileKey(8, 100, 50)
    const layerCache = new Map<number, unknown>([[visibleKey, {}]])
    // hasOtherSliceHeld omitted entirely — old call sites unaffected.
    const d = classifyTile(baseInputs({ visibleKey, layerCache }))
    expect(d.kind).toBe('primary')
  })

  it('hasOtherSliceHeld=true + GPU hit + cached ancestor → parent-fallback (override)', () => {
    // The visible slice IS on GPU but a peer slice is held — primary
    // would visually disagree with the held layer's parent stretch,
    // so we coerce this layer to the same parent.
    const visibleKey = tileKey(8, 100, 50)
    const parentKey = tileKeyParent(visibleKey)
    const layerCache = new Map<number, unknown>([
      [visibleKey, {}],
      [parentKey, {}],   // ancestor on GPU too — no upload needed
    ])
    const d = classifyTile(baseInputs({
      visibleKey,
      layerCache,
      hasSliceInCatalog: (k) => k === visibleKey || k === parentKey,
      hasOtherSliceHeld: true,
    }))
    expect(d.kind).toBe('parent-fallback')
    if (d.kind === 'parent-fallback') {
      expect(d.parentKey).toBe(parentKey)
      expect(d.parentNeedsUpload).toBe(false)
    }
  })

  it('hasOtherSliceHeld=true + visible-not-on-GPU + slice in catalog → queued-with-fallback (existing path)', () => {
    // When THIS layer's slice is also still mid-upload, the existing
    // queued-with-fallback path handles it the same way as before —
    // the override is only meaningful when the visible IS on GPU.
    const visibleKey = tileKey(8, 100, 50)
    const parentKey = tileKeyParent(visibleKey)
    const layerCache = new Map<number, unknown>([[parentKey, {}]])
    const d = classifyTile(baseInputs({
      visibleKey,
      layerCache,
      hasSliceInCatalog: (k) => k === visibleKey || k === parentKey,
      hasOtherSliceHeld: true,
    }))
    expect(d.kind).toBe('queued-with-fallback')
    if (d.kind === 'queued-with-fallback') {
      expect(d.fallback.kind).toBe('parent-fallback')
    }
  })
})

describe('computeProtectedKeys', () => {
  it('always includes every stableKey', () => {
    const keys = [tileKey(8, 100, 50), tileKey(8, 200, 100)]
    const protect = computeProtectedKeys(keys, 4, tileKeyParent)
    for (const k of keys) expect(protect.has(k)).toBe(true)
  })

  it('protects exactly `depth` levels of ancestors', () => {
    const visibleKey = tileKey(10, 500, 300)
    const protect = computeProtectedKeys([visibleKey], 3, tileKeyParent)
    // Should contain visibleKey + 3 parents (z=9, z=8, z=7)
    let pk = visibleKey
    for (let d = 0; d < 3; d++) {
      pk = tileKeyParent(pk)
      expect(protect.has(pk), `parent depth ${d + 1} present`).toBe(true)
    }
    // The 4th parent (z=6) should NOT be in protected set
    pk = tileKeyParent(pk)
    expect(protect.has(pk), 'parent at depth 4 not present').toBe(false)
  })

  it('size grows linearly with stableKeys + depth (no exponential blowup)', () => {
    const keys = Array.from({ length: 20 }, (_, i) => tileKey(12, i, i))
    const protect = computeProtectedKeys(keys, 4, tileKeyParent)
    // Worst case: 20 visible × (1 + 4 ancestors) = 100
    // In practice many ancestors overlap; assert ≤ 100
    expect(protect.size).toBeLessThanOrEqual(100)
    expect(protect.size).toBeGreaterThanOrEqual(20)
  })

  it('handles z=0 root correctly (no parent to walk)', () => {
    const rootKey = tileKey(0, 0, 0)  // = 1
    const protect = computeProtectedKeys([rootKey], 4, tileKeyParent)
    expect(protect.size).toBe(1)
    expect(protect.has(rootKey)).toBe(true)
  })

  it('reuses provided output Set (avoids allocation)', () => {
    const out = new Set<number>([999])  // sentinel
    const ret = computeProtectedKeys([tileKey(8, 100, 50)], 2, tileKeyParent, out)
    expect(ret).toBe(out)
    expect(out.has(999)).toBe(true)  // sentinel preserved
    expect(out.size).toBe(4)  // sentinel + key + 2 ancestors
  })
})

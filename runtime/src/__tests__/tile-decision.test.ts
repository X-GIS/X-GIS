// Unit tests for classifyTile — the pure tile-resolution classifier
// extracted from VectorTileRenderer's per-tile loop. The point of
// having a pure function is to catch decision-logic bugs at the unit
// level instead of waiting for visual regressions to surface.

import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import { classifyTile, type ClassifyTileInputs, type TileDecision } from '../engine/tile-decision'

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

// Regression: filter_gdp emerald/yellow rendered NOTHING because inline
// GeoJSON shows have empty `sourceLayer` and the old code skipped them
// when building `showSlicesBySource`. The backend then didn't know about
// per-show filters and emitted only the unfiltered base slice; filtered
// shows looked up missing sliceKeys and silently rendered nothing.
//
// Fix (show-source-maps.ts): fall back to `targetName` when sourceLayer
// is empty. This test pins the contract so the silent-mercator-class
// drop can't be reintroduced.

import { describe, it, expect } from 'vitest'
import { buildShowSourceMaps } from './show-source-maps'

// Minimal mock — real ShowCommand carries many fields but only these
// matter for showSlicesBySource. Cast through `as never` to keep the
// test focused on the surface under test instead of mirroring the full
// ShowCommand type.
type MinimalShow = {
  targetName: string
  sourceLayer?: string
  filterExpr?: { ast: unknown } | null
  label?: unknown
  shaderVariant?: { needsFeatureBuffer?: boolean }
}

const show = (s: MinimalShow): never => s as never

describe('buildShowSourceMaps showSlicesBySource', () => {
  it('inline GeoJSON shows (no sourceLayer) still get slice entries', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'countries' }),  // no filter, no sourceLayer
    ])
    const list = showSlicesBySource.get('countries')
    expect(list, 'inline GeoJSON show should get a slice list').toBeTruthy()
    expect(list).toHaveLength(1)
    // Falls back to targetName so the worker's byLayer lookup
    // (keyed by `_layer` = sourceName for inline tiles) matches.
    expect(list![0]!.sourceLayer).toBe('countries')
  })

  it('inline filtered shows get a distinct sliceKey per filter', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'countries' }),
      show({ targetName: 'countries', filterExpr: { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 1 } } }),
      show({ targetName: 'countries', filterExpr: { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 5 } } }),
    ])
    const list = showSlicesBySource.get('countries')!
    expect(list).toHaveLength(3)
    const sliceKeys = new Set(list.map(s => s.sliceKey))
    expect(sliceKeys.size, 'three distinct sliceKeys for unfiltered + two filters').toBe(3)
    // First entry is the unfiltered base; its sliceKey collapses to
    // bare sourceLayer (the targetName fallback).
    expect(list[0]!.sliceKey).toBe('countries')
  })

  it('MVT shows with explicit sourceLayer still use it (no fallback)', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'protomaps', sourceLayer: 'water' }),
      show({ targetName: 'protomaps', sourceLayer: 'roads' }),
    ])
    const list = showSlicesBySource.get('protomaps')!
    expect(list).toHaveLength(2)
    // sourceLayer is explicit and meaningful for MVT — don't override
    // it with targetName.
    expect(list.map(s => s.sourceLayer).sort()).toEqual(['roads', 'water'])
  })
})

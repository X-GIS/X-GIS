// Pins the contract between the worker-side slice store (keyed by
// sliceKey) and the runtime-side label iterators in map.ts.
//
// The bug this regression locks in:
//   `computeSliceKey(sourceLayer, filterAst)` returns `sourceLayer`
//   when the filter is null/undefined, BUT returns
//   `${sourceLayer}::${hash}` once any filter is set. map.ts used
//   to pass `show.sourceLayer` to `forEachLabelFeature`, so any
//   show with a filter (Mapbox `label_country_*`, `label_city`,
//   `label_town`, all POI labels — i.e. effectively every Mapbox
//   text label that isn't ocean / waterway / coastline) looked up
//   the bare `place` key in the per-tile slice map, got null, and
//   rendered nothing. Users saw only the unfiltered Italic water
//   names ("한강", "양재천") and reported "country labels missing".

import { describe, it, expect } from 'vitest'
import { computeSliceKey } from './filter-eval'

describe('computeSliceKey', () => {
  it('collapses to bare sourceLayer when no filter is set', () => {
    expect(computeSliceKey('waterway', null)).toBe('waterway')
    expect(computeSliceKey('waterway', undefined)).toBe('waterway')
  })

  it('produces a sourceLayer::<hash> key when a filter is present', () => {
    const country = computeSliceKey('place', {
      op: '==', left: { kind: 'get', key: 'class' }, right: 'country',
    } as never)
    expect(country.startsWith('place::')).toBe(true)
    expect(country).not.toBe('place')
  })

  it('different filters on the same sourceLayer produce distinct keys', () => {
    const k1 = computeSliceKey('place', {
      op: '==', left: { kind: 'get', key: 'class' }, right: 'country',
    } as never)
    const k2 = computeSliceKey('place', {
      op: '==', left: { kind: 'get', key: 'class' }, right: 'city',
    } as never)
    // Otherwise `label_country_3` and `label_city` would share a
    // slice in the per-tile cache — and the renderer would emit
    // city labels under country styling (or vice versa).
    expect(k1).not.toBe(k2)
  })

  it('same filter ASTs (same JSON shape) collapse to one key', () => {
    const k1 = computeSliceKey('place', {
      op: '==', left: { kind: 'get', key: 'class' }, right: 'country',
    } as never)
    const k2 = computeSliceKey('place', {
      op: '==', left: { kind: 'get', key: 'class' }, right: 'country',
    } as never)
    expect(k1).toBe(k2)
  })
})

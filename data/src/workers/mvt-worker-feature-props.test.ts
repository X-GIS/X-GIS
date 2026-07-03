// featureProps field-filter perf opt (worker side).
//
// The MVT worker structured-clones a featId → properties Map across the
// worker→main boundary; that clone is the dominant tile-transition cost
// (309 ms/msg on OFM Bright). buildFeatureProps restricts the clone to
// only the keys a slice's consumers (label text-field + data-driven
// variant featureFields) actually read — the keys travel on the
// showSlices descriptor as featurePropKeys, computed by
// show-source-maps.buildShowSourceMaps.
//
// Imports the worker module directly: mvt-worker.ts gates its
// `self.addEventListener` on DedicatedWorkerGlobalScope, so it loads
// cleanly in vitest's node env (same pattern as geojson-compile-worker).

import { describe, expect, it } from 'vitest'
import { buildFeatureProps } from './mvt-worker'
import type { GeoJSONFeature } from '@xgis/compiler'

const feat = (properties: Record<string, unknown>): GeoJSONFeature =>
  ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties,
  }) as GeoJSONFeature

describe('buildFeatureProps — field filtering', () => {
  it('keeps ONLY the requested keys, dropping the rest', () => {
    const features = [
      feat({ name: 'Seoul', 'name:en': 'Seoul', class: 'city', rank: 1, population: 9_733_509 }),
    ]
    const out = buildFeatureProps(features, ['name'])
    expect(out.get(0)).toEqual({ name: 'Seoul' })
    // The heavy / unused fields are gone.
    expect(out.get(0)).not.toHaveProperty('name:en')
    expect(out.get(0)).not.toHaveProperty('class')
    expect(out.get(0)).not.toHaveProperty('population')
  })

  it('keeps multiple requested keys', () => {
    const out = buildFeatureProps([feat({ name: 'A', class: 'park', extra: 1 })], ['class', 'name'])
    expect(out.get(0)).toEqual({ name: 'A', class: 'park' })
  })

  it('omits a requested key the feature lacks (no undefined entries)', () => {
    const out = buildFeatureProps([feat({ name: 'A' })], ['name', 'class'])
    // `class` absent on the feature → not copied (so it stays absent, not =undefined).
    expect(out.get(0)).toEqual({ name: 'A' })
    expect('class' in out.get(0)!).toBe(false)
  })

  it('undefined keys → FULL props (legacy / safe fallback)', () => {
    const props = { name: 'A', class: 'city', population: 5 }
    const out = buildFeatureProps([feat(props)], undefined)
    expect(out.get(0)).toEqual(props)
  })

  it('empty keys array → FULL props (un-introspectable-label fallback)', () => {
    const props = { name: 'A', class: 'city' }
    const out = buildFeatureProps([feat(props)], [])
    expect(out.get(0)).toEqual(props)
  })

  it('indexes by feature order (featId == source index)', () => {
    const out = buildFeatureProps([feat({ name: 'A' }), feat({ name: 'B' })], ['name'])
    expect(out.get(0)).toEqual({ name: 'A' })
    expect(out.get(1)).toEqual({ name: 'B' })
    expect(out.size).toBe(2)
  })
})

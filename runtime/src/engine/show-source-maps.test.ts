// Regression: filter_gdp emerald/yellow rendered NOTHING because inline
// GeoJSON shows have empty `sourceLayer` and the old code skipped them
// when building per-source maps. The backend then didn't know about the
// per-show filter / extrude / data-driven paint inputs and emitted only
// the unfiltered base; downstream consumers looked up missing sliceKeys
// and silently rendered nothing.
//
// Fix (show-source-maps.ts + vector-tile-renderer.ts + map.ts label
// path): a single `effectiveLayer = sourceLayer || targetName` fallback
// is applied at every key derivation site so worker output and
// renderer lookups agree. This test pins the contract across ALL the
// per-source maps so the silent-mercator-class drop can't reappear in
// any of the 6 derivation sites.

import { describe, it, expect } from 'vitest'
import { buildShowSourceMaps } from './show-source-maps'
import { computeSliceKey } from '../data/eval/filter-eval'

type MinimalShow = {
  targetName: string
  sourceLayer?: string
  filterExpr?: { ast: unknown } | null
  label?: unknown
  shaderVariant?: { needsFeatureBuffer?: boolean }
  extrude?: { kind: string; expr?: { ast: unknown } } | undefined
  extrudeBase?: { kind: string; expr?: { ast: unknown } } | undefined
  strokeWidthExpr?: { ast: unknown } | undefined
  strokeColorExpr?: { ast: unknown } | undefined
}

const show = (s: MinimalShow): never => s as never
const FILTER_GT_1M = { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 1_000_000 } }
const FILTER_GT_5M = { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 5_000_000 } }

describe('buildShowSourceMaps showSlicesBySource — filter routing', () => {
  it('inline GeoJSON shows (no sourceLayer) still get slice entries', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'countries' }),
    ])
    const list = showSlicesBySource.get('countries')
    expect(list, 'inline GeoJSON show should get a slice list').toBeTruthy()
    expect(list).toHaveLength(1)
    expect(list![0]!.sourceLayer).toBe('countries')
  })

  it('inline filtered shows get a distinct sliceKey per filter', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'countries' }),
      show({ targetName: 'countries', filterExpr: FILTER_GT_1M }),
      show({ targetName: 'countries', filterExpr: FILTER_GT_5M }),
    ])
    const list = showSlicesBySource.get('countries')!
    expect(list).toHaveLength(3)
    expect(new Set(list.map(s => s.sliceKey)).size, '3 unique sliceKeys').toBe(3)
    expect(list[0]!.sliceKey).toBe('countries')
  })

  it('MVT shows with explicit sourceLayer still use it (no fallback)', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'protomaps', sourceLayer: 'water' }),
      show({ targetName: 'protomaps', sourceLayer: 'roads' }),
    ])
    const list = showSlicesBySource.get('protomaps')!
    expect(list.map(s => s.sourceLayer).sort()).toEqual(['roads', 'water'])
  })
})

// Same silent-drop class hit all 5 per-source maps before the
// `effectiveLayer` fallback. These pin each map so a future regression
// in the helper / inline GeoJSON gate trips loudly.
describe('buildShowSourceMaps — all 5 maps honour inline GeoJSON shows', () => {
  it('usedSourceLayers includes inline GeoJSON layers', () => {
    const { usedSourceLayers } = buildShowSourceMaps([
      show({ targetName: 'countries' }),
    ])
    expect(usedSourceLayers.get('countries')?.has('countries')).toBe(true)
  })

  it('extrudeExprsBySource indexes inline-show extrude under targetName', () => {
    const { extrudeExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrude: { kind: 'feature', expr: { ast: 'h' } } }),
    ])
    const layerMap = extrudeExprsBySource.get('buildings')
    expect(layerMap, 'inline extrude show should produce a layerMap').toBeTruthy()
    expect(layerMap!['buildings']).toBe('h')
  })

  it('extrudeBaseExprsBySource indexes inline-show extrudeBase under targetName', () => {
    const { extrudeBaseExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrudeBase: { kind: 'feature', expr: { ast: 'b' } } }),
    ])
    expect(extrudeBaseExprsBySource.get('buildings')?.['buildings']).toBe('b')
  })

  it('strokeWidthExprsBySource indexes inline-show width-expr by sliceKey', () => {
    const { strokeWidthExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'rivers', strokeWidthExpr: { ast: 'w' } }),
      show({ targetName: 'rivers', strokeWidthExpr: { ast: 'w2' }, filterExpr: FILTER_GT_1M }),
    ])
    const layerMap = strokeWidthExprsBySource.get('rivers')!
    expect(Object.keys(layerMap).length).toBe(2)
    expect(layerMap[computeSliceKey('rivers', null)]).toBe('w')
    expect(layerMap[computeSliceKey('rivers', FILTER_GT_1M.ast)]).toBe('w2')
  })

  it('strokeColorExprsBySource indexes inline-show colour-expr by sliceKey', () => {
    const { strokeColorExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'roads', strokeColorExpr: { ast: 'c' } }),
    ])
    expect(strokeColorExprsBySource.get('roads')?.[computeSliceKey('roads', null)]).toBe('c')
  })
})

// Cross-path invariant: the sliceKey the BACKEND emits (derived from
// the showSlices descriptor we hand it) MUST equal the sliceKey the
// renderer-side path computes for the same show. Without this contract
// pinned, the two sides can silently drift — which is exactly what
// happened with filter_gdp: backend emitted 'countries' (no filter)
// while VTR's runtime path looked up '' (the bare sourceLayer with no
// targetName fallback). Both code paths now use the same
// `sourceLayer || targetName` fallback; this test asserts they agree
// for a representative input set.
describe('cross-path sliceKey invariant (backend ↔ renderer)', () => {
  // Mirror of vector-tile-renderer.ts:2422 and the label path at
  // map.ts:3494. Updating either of those without updating this test
  // means the renderer side has drifted from the backend side.
  const rendererSliceKey = (s: MinimalShow): string =>
    computeSliceKey(s.sourceLayer || s.targetName || '', s.filterExpr?.ast ?? null)

  it('inline + filter combinations all agree', () => {
    const shows: MinimalShow[] = [
      { targetName: 'countries' },
      { targetName: 'countries', filterExpr: FILTER_GT_1M },
      { targetName: 'countries', filterExpr: FILTER_GT_5M },
      { targetName: 'water', sourceLayer: 'water' },
      { targetName: 'protomaps', sourceLayer: 'roads', filterExpr: FILTER_GT_1M },
    ]
    const { showSlicesBySource } = buildShowSourceMaps(shows.map(show))
    for (const s of shows) {
      const list = showSlicesBySource.get(s.targetName)!
      const filterAst = s.filterExpr?.ast ?? null
      const backendEntry = list.find(e => e.filterAst === filterAst)
      expect(backendEntry,
        `backend slice missing for target=${s.targetName} filter=${!!filterAst}`).toBeTruthy()
      expect(backendEntry!.sliceKey,
        `backend (${backendEntry!.sliceKey}) ↔ renderer (${rendererSliceKey(s)}) drift on ${s.targetName}`,
      ).toBe(rendererSliceKey(s))
    }
  })
})

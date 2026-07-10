// Regression for #613 — MapLibre-parity per-source-layer maxzoom cull.
//
// The MapLibre demotiles style draws lat/lon reference lines (Arctic
// Circle / Tropic of Cancer / Equator / Tropic of Capricorn) from the
// `geolines` MVT source-layer. That layer's tilejson `vector_layers`
// entry declares maxzoom 4 while the SOURCE tilejson maxzoom is 6, so
// the native z5/z6 tiles carry no geolines — MapLibre renders the empty
// native slice and the Tropic/Equator lines + labels VANISH at z5. X-GIS
// used to keep drawing them past z5 by over-zooming the z4 data.
//
// Two independent render paths must cull in lockstep:
//   • lines  — TileSelectionCache.selectForFrame returns null so VTR
//              skips the slice (this file: the selectForFrame cases).
//   • labels — VectorTileRenderer.sourceLayerOutsideDataZoom gates the
//              along-path label walk in label-pass.ts.
//
// The geolines layers carry a filter (`name != 'International Date
// Line'`), so their sliceLayer is the `geolines::<hash>` computeSliceKey
// form — the cull must strip the filter suffix before the
// vector_layers lookup or it silently no-ops (the pre-#613 gap).

import { describe, expect, it } from 'vitest'
import { Camera } from '../camera'
import { VectorTileRenderer } from './vector-tile-renderer'
import { TileSelectionCache, sliceOutsideDataZoomRange } from './tile-selection-cache'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

type Range = { minzoom: number; maxzoom: number }

// Minimal catalog exposing only what selectForFrame's cull + flat
// (mercator) selection path touch: maxLevel, getLayerZoomRange, and
// hasEntryInIndex for the ancestor walk. The readiness block is skipped
// on a fresh cache's first call (_hysteresisZ < 0), so hasTileData /
// prefetchTiles are never reached.
function fakeCatalog(
  maxLevel: number,
  ranges: Record<string, Range>,
  onQuery?: (name: string) => void,
): TileCatalog {
  return {
    maxLevel,
    getLayerZoomRange: (name: string): Range | null => {
      onQuery?.(name)
      return ranges[name] ?? null
    },
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
  } as unknown as TileCatalog
}

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

// Australia — the issue's repro location; any land centre works since
// the cull returns before tile selection on the culled cases.
function select(cache: TileSelectionCache, zoom: number, sliceLayer: string, source: TileCatalog) {
  const camera = new Camera(133, -25, zoom)
  return cache.selectForFrame(
    camera,
    0, // projType — mercator (flat selection path)
    0,
    0,
    1024,
    768,
    1,
    1, // frameId
    source,
    sliceLayer,
    2,
    source.maxLevel,
    NO_STATS,
  )
}

describe('sliceOutsideDataZoomRange — per-source-layer data band predicate', () => {
  it('treats a null range (no vector_layers metadata) as always-present', () => {
    expect(sliceOutsideDataZoomRange(null, 5)).toBe(false)
    expect(sliceOutsideDataZoomRange(undefined, 20)).toBe(false)
  })

  it('culls above maxzoom and below minzoom, inclusive band in between', () => {
    const geolines: Range = { minzoom: 0, maxzoom: 4 }
    expect(sliceOutsideDataZoomRange(geolines, 4)).toBe(false) // AT max → present
    expect(sliceOutsideDataZoomRange(geolines, 5)).toBe(true) // above max → culled
    const roads: Range = { minzoom: 6, maxzoom: 15 }
    expect(sliceOutsideDataZoomRange(roads, 5)).toBe(true) // below min → culled
    expect(sliceOutsideDataZoomRange(roads, 6)).toBe(false)
    expect(sliceOutsideDataZoomRange(roads, 15)).toBe(false)
  })
})

describe('TileSelectionCache.selectForFrame — #613 geolines maxzoom cull (line path)', () => {
  const DEMOTILES = { geolines: { minzoom: 0, maxzoom: 4 }, countries: { minzoom: 0, maxzoom: 6 } }

  it('culls the filtered geolines slice at z5 (source max 6, layer max 4)', () => {
    // The demotiles geolines line layer is filtered → `geolines::<hash>`.
    const queried: string[] = []
    const source = fakeCatalog(6, DEMOTILES, (n) => queried.push(n))
    const sel = select(new TileSelectionCache(), 5, 'geolines::ab12cd', source)
    expect(sel).toBeNull()
    // The filter suffix must be stripped so getLayerZoomRange sees the
    // bare source-layer — the pre-#613 lookup passed the full sliceKey
    // and got null, silently skipping the cull.
    expect(queried).toContain('geolines')
    expect(queried).not.toContain('geolines::ab12cd')
  })

  it('keeps the geolines slice at z4 (AT the layer maxzoom, native tile has data)', () => {
    const source = fakeCatalog(6, DEMOTILES, undefined)
    expect(select(new TileSelectionCache(), 4, 'geolines::ab12cd', source)).not.toBeNull()
  })

  it('keeps the countries slice at z5 (layer max 6 == source max, still present)', () => {
    const source = fakeCatalog(6, DEMOTILES, undefined)
    expect(select(new TileSelectionCache(), 5, 'countries', source)).not.toBeNull()
  })

  it('never culls an over-zoomed layer whose max == source max (protomaps v4)', () => {
    // roads maxzoom 15 == source maxLevel 15: at camera z18 currentZ
    // clamps to 15, so 15 > 15 is false and over-zoom keeps drawing.
    const source = fakeCatalog(15, { roads: { minzoom: 6, maxzoom: 15 } }, undefined)
    expect(select(new TileSelectionCache(), 18, 'roads', source)).not.toBeNull()
  })
})

describe('VectorTileRenderer.sourceLayerOutsideDataZoom — #613 label path cull', () => {
  function vtrWith(maxLevel: number, ranges: Record<string, Range>): VectorTileRenderer {
    const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
    ;(vtr as unknown as { source: TileCatalog }).source = fakeCatalog(maxLevel, ranges)
    return vtr
  }

  it('drops geolines labels at z5, keeps them at z4 (floor(zoom) vs layer max 4)', () => {
    const vtr = vtrWith(6, {
      geolines: { minzoom: 0, maxzoom: 4 },
      countries: { minzoom: 0, maxzoom: 6 },
    })
    expect(vtr.sourceLayerOutsideDataZoom('geolines', 4.9)).toBe(false) // floor → 4
    expect(vtr.sourceLayerOutsideDataZoom('geolines', 5.0)).toBe(true) // floor → 5 > 4
    expect(vtr.sourceLayerOutsideDataZoom('geolines', 10)).toBe(true)
    // countries persists (max 6) — the border labels stay past z5.
    expect(vtr.sourceLayerOutsideDataZoom('countries', 5)).toBe(false)
  })

  it('clamps to source maxLevel so over-zoom past the source max never culls', () => {
    const vtr = vtrWith(15, { roads: { minzoom: 6, maxzoom: 15 } })
    expect(vtr.sourceLayerOutsideDataZoom('roads', 18)).toBe(false) // clamp 15, 15 > 15 false
    expect(vtr.sourceLayerOutsideDataZoom('roads', 4)).toBe(true) // below min 6
  })

  it('reports present for a layer without vector_layers metadata', () => {
    const vtr = vtrWith(14, {})
    expect(vtr.sourceLayerOutsideDataZoom('anything', 20)).toBe(false)
  })
})

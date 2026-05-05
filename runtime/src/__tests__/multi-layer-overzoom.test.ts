// Reproduction for the multi-layer PMTiles over-zoom bug:
// "appears and disappears" — at over-zoom past the archive's maxZoom,
// some layers' sub-tiles never get generated for some viewport tiles.
// User-visible symptom: viewport flickers between partial coverage
// states because each frame only some layers' sub-tiles complete.
//
// The catalog hosts ONE parent tile loaded with N source-layer slices
// (water + landuse + roads + buildings, mirroring pmtiles_layered).
// We then ask each layer (in order) to generate sub-tiles for a
// quad of children at z=N+1, simulating the per-layer
// generateSubTile invocations VTR.render makes when the bucket
// scheduler walks ShowCommands.
//
// The bug surfaces when one layer's call exhausts the per-call
// budget (time + count) and subsequent layers' calls fail. With
// per-call budgets that share an internal `_subTileCountThisFrame`
// across resets within the same frame, the reset is per call so
// each layer gets a fresh budget — but a TIME budget that includes
// the previous layer's compile work runs OUT before the late
// layers' sub-tiles can be generated.

import { describe, expect, it } from 'vitest'
import {
  compileGeoJSONToTiles, decomposeFeatures, tileKey,
  type GeoJSONFeatureCollection,
} from '@xgis/compiler'
import { TileCatalog } from '../data/tile-catalog'
import { DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE } from '../data/tile-types'

// Make a polygon FeatureCollection that fully covers a z=1 tile.
function squareInTile(z: number, x: number, y: number): GeoJSONFeatureCollection {
  const tn = Math.pow(2, z)
  const lonW = (x / tn) * 360 - 180
  const lonE = ((x + 1) / tn) * 360 - 180
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / tn))) * 180 / Math.PI
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / tn))) * 180 / Math.PI
  // Inset slightly so clipping isn't degenerate at the edges.
  const lon0 = lonW + (lonE - lonW) * 0.05
  const lon1 = lonW + (lonE - lonW) * 0.95
  const lat0 = latS + (latN - latS) * 0.05
  const lat1 = latS + (latN - latS) * 0.95
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[
        [lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0],
      ]] },
    }],
  }
}

describe('multi-layer over-zoom: per-layer generateSubTile across one frame', () => {
  it('all 4 sliced layers generate sub-tiles for the same z=2 quad', () => {
    // Build a catalog and load the SAME polygon as 4 different layer
    // slices for parent tile (1, 1, 0). The slice name simulates the
    // PMTiles per-MVT-layer split: water, landuse, roads, buildings.
    const source = new TileCatalog()
    const parentZ = 1, parentX = 1, parentY = 0
    const parentKey = tileKey(parentZ, parentX, parentY)
    const fc = squareInTile(parentZ, parentX, parentY)
    decomposeFeatures(fc.features)
    const set = compileGeoJSONToTiles(fc, { minZoom: 1, maxZoom: 1 })

    // Manually populate parent slices via the public path that VTR
    // would have used: loadFromTileSet stores under the default ''
    // slot. To simulate per-MVT-layer slicing we reach in via the
    // private setSlice equivalent — emulating what PMTilesBackend
    // would have produced. The simplest way is loadFromTileSet for
    // each slice name; we cheat by loading once, then reaching the
    // dataCache directly is not part of the public API. Instead use
    // the catalog's acceptResult-like path via cacheTileData? That's
    // also private. We rely on the fact that addTileLevel + the new
    // sourceLayer-aware setSlice exists in the implementation.
    source.loadFromTileSet(set)
    // After loadFromTileSet the parent is stored under '' slot. We
    // mirror it under each of the 4 layer names so generateSubTile
    // (which reads getTileData(parentKey, sourceLayer)) finds them.
    const baseParent = source.getTileData(parentKey)
    expect(baseParent).not.toBeNull()
    const layerNames = ['water', 'landuse', 'roads', 'buildings']
    // Reach into the source via type assertion since setSlice is private.
    const setSlice = (source as unknown as {
      setSlice(key: number, layer: string, data: typeof baseParent): void
    }).setSlice.bind(source)
    for (const ln of layerNames) {
      setSlice(parentKey, ln, baseParent!)
    }

    // Pick a z=2 child of parentKey (any child; (2, 2, 0) sits inside
    // (1, 1, 0)'s east hemisphere, NE quadrant).
    const subKey = tileKey(2, 2, 0)

    // Reset budget once at start of "frame", then call generateSubTile
    // for each of the 4 layers in succession — exactly what the
    // bucket scheduler does when 4 ShowCommands share one source.
    source.resetCompileBudget(1)
    const results: { layer: string; ok: boolean }[] = []
    for (const ln of layerNames) {
      const ok = source.generateSubTile(subKey, parentKey, ln)
      results.push({ layer: ln, ok })
    }

    console.log('[overzoom-repro]', JSON.stringify(results))
    // CORRECT BEHAVIOR: every layer's sub-tile should generate.
    // BUG: with frame-shared budget, the FIRST layer's compile time
    // exhausts _BUDGET_MS and subsequent layers fail.
    for (const r of results) {
      expect(r.ok, `layer "${r.layer}" sub-tile gen failed — budget likely starved`).toBe(true)
    }

    // And each layer's sub-tile slot should now hold real geometry.
    for (const ln of layerNames) {
      const sub = source.getTileData(subKey, ln)
      expect(sub, `${ln} sub-tile missing in dataCache`).not.toBeNull()
      const polyVerts = sub!.vertices.length / DSFUN_POLY_STRIDE
      const lineVerts = sub!.lineVertices.length / DSFUN_LINE_STRIDE
      expect(
        polyVerts > 0 || lineVerts > 0,
        `${ln} sub-tile has no geometry`,
      ).toBe(true)
    }
  })

  it('sub-tiles persist across many frames at over-zoom (no gradual disappearance)', () => {
    // Repro for "tiles gradually disappear at z=15.5+" — simulate
    // 60 frames of static-camera over-zoom and assert the cached
    // sub-tile count never DROPS frame to frame. Hypothesised
    // failure modes:
    //   - generateSubTile re-runs after first cache hit (overwrites)
    //   - hasTileData early-exit returns false despite slot present
    //   - dataCache silently evicts entries
    //   - some frame counter / budget interaction returns false on
    //     a successful cached check
    const source = new TileCatalog()
    const fc = squareInTile(1, 1, 0)
    decomposeFeatures(fc.features)
    const set = compileGeoJSONToTiles(fc, { minZoom: 1, maxZoom: 1 })
    source.loadFromTileSet(set)
    const parentKey = tileKey(1, 1, 0)
    const baseParent = source.getTileData(parentKey)!
    const setSlice = (source as unknown as {
      setSlice(key: number, layer: string, data: typeof baseParent): void
    }).setSlice.bind(source)
    const layers = ['water', 'landuse', 'roads', 'buildings']
    for (const ln of layers) setSlice(parentKey, ln, baseParent)

    // Four "viewport" sub-keys at z=2 (within the parent quadrant).
    const subKeys = [
      tileKey(2, 2, 0), tileKey(2, 3, 0),
      tileKey(2, 2, 1), tileKey(2, 3, 1),
    ]

    let snapshot: number[] = []
    for (let frame = 1; frame <= 60; frame++) {
      // Each layer's render() resets the budget.
      for (const ln of layers) {
        source.resetCompileBudget(frame)
        for (const sk of subKeys) {
          source.generateSubTile(sk, parentKey, ln)
        }
      }
      // Count cached sub-tiles across all layers.
      let count = 0
      for (const sk of subKeys) {
        for (const ln of layers) {
          if (source.hasTileData(sk, ln)) count++
        }
      }
      snapshot.push(count)
      if (frame > 1 && count < snapshot[frame - 2]) {
        // Cache count went DOWN — bug.
        console.error('[overzoom-repro] gradual loss at frame', frame, 'snapshot:', snapshot)
        expect.fail(`sub-tile count decreased from ${snapshot[frame - 2]} to ${count} at frame ${frame}`)
      }
    }
    // After steady state, all 16 (4 sub × 4 layers) must be cached.
    expect(snapshot[snapshot.length - 1]).toBe(subKeys.length * layers.length)
  })

  it('subsequent VTR renders within the same frame share the budget reset (frameId guard)', () => {
    // After the user reported "appears and disappears", the first
    // attempt at frame-shared budget short-circuited the second
    // resetCompileBudget call so the time deadline kept ticking
    // from the FIRST call. By the time layer 4 ran, the deadline
    // had passed → budgetExceeded returned true past the floor,
    // starving late layers. This test asserts that a second reset
    // call WITHIN the same frame DOES still allow at least the
    // floor-many sub-tiles to fire (count-only short-circuit, not
    // a starve).
    const source = new TileCatalog()
    const fc = squareInTile(1, 1, 0)
    decomposeFeatures(fc.features)
    const set = compileGeoJSONToTiles(fc, { minZoom: 1, maxZoom: 1 })
    source.loadFromTileSet(set)
    const parentKey = tileKey(1, 1, 0)
    const baseParent = source.getTileData(parentKey)!
    const setSlice = (source as unknown as {
      setSlice(key: number, layer: string, data: typeof baseParent): void
    }).setSlice.bind(source)
    setSlice(parentKey, 'a', baseParent)
    setSlice(parentKey, 'b', baseParent)

    // Frame 1: layer 'a' generates a sub-tile after reset.
    source.resetCompileBudget(1)
    const ok1 = source.generateSubTile(tileKey(2, 2, 0), parentKey, 'a')
    expect(ok1, 'layer a sub-tile').toBe(true)

    // Layer 'b' simulates the SECOND VTR render within the same
    // frame (same frameId). It should still be able to generate at
    // least the floor — sharing the reset guard must not starve.
    source.resetCompileBudget(1)  // same frameId — short-circuits
    const ok2 = source.generateSubTile(tileKey(2, 2, 1), parentKey, 'b')
    expect(ok2, 'layer b sub-tile (same frame)').toBe(true)
  })
})

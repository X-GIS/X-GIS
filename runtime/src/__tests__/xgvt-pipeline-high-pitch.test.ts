import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum, firstIndexedAncestor } from '../data/tile-select'
import { mercator } from '../engine/projection/projection'
import {
  tileKey, tileKeyUnpack,
  parseXGVTIndex, parsePropertyTable,
  type XGVTIndex,
} from '@xgis/compiler'

// XGVT INDEX-LEVEL PIPELINE TESTS at the bug URL's camera state:
//
//   demo.html?id=physical_map_50m
//     #10.29/30.94565/117.95751/359.5/84.0
//
// We test at the INDEX level (parseXGVTIndex output), NOT by
// instantiating an TileCatalog, because:
//   - Full TileCatalog.loadFromBuffer triggers a worker-pool parse for
//     compact tiles — Node vitest has no `Worker` global so that path
//     fails.
//   - The user's symptom ("tiles don't load") is ultimately decided
//     by whether the INDEX promises a drawable tile for every camera-
//     selected coordinate. If the index has it, the loader will
//     eventually deliver it (barring orthogonal network failures). If
//     the index doesn't have it and has no ancestor, no amount of
//     downstream retry can rescue the frame.
//
// XGVT files for physical_map_50m:
//   ne_110m_ocean.xgvt   (ocean fill)
//   ne_110m_land.xgvt    (land fill)
//   ne_50m_rivers.xgvt   (rivers line)
//   ne_50m_lakes.xgvt    (lakes fill)
//
// We test the LAND source (ne_110m_land.xgvt, 180 KB) — smallest but
// covers exactly the pixels a user viewing mainland China expects to
// see. If land doesn't draw at the bug URL, the screen looks empty
// regardless of what ocean/rivers/lakes do.
//
// PER-TILE ORACLE (mirrors VectorTileRenderer.renderTileKeys):
//   1. Exact (z, x, y) in index? → direct hit, tile loads.
//   2. Else: `firstIndexedAncestor(key, indexHas)` finds an ancestor?
//      → sub-tile clip path, rendering via the ancestor while
//        successive frames refine via generateSubTile.
//   3. Neither? → ORPHAN. Structural "no-draw" state. The exact
//      symptom of "tiles don't load".

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '../../../playground/public/data')
const LAND_XGVT_PATH = resolve(DATA_DIR, 'ne_110m_land.xgvt')

const W = 1024
const H = 768

const BUG = {
  zoom: 10.29,
  lat: 30.94565,
  lon: 117.95751,
  bearing: 359.5,
  pitch: 84.0,
} as const

function makeBugCam(): Camera {
  const c = new Camera(BUG.lon, BUG.lat, BUG.zoom)
  c.pitch = BUG.pitch
  c.bearing = BUG.bearing
  return c
}

/** Parse an .xgvt file's index (+ property table) without instantiating
 *  an TileCatalog — bypasses the async worker-pool preload path that
 *  needs a browser Worker global. */
function parseXgvtFromFile(path: string): XGVTIndex {
  const nodeBuf = readFileSync(path)
  const buf = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)
  const idx = parseXGVTIndex(buf)
  const { propTableOffset, propTableLength } = idx.header
  if (propTableOffset > 0 && propTableLength > 0) {
    const propBuf = buf.slice(propTableOffset, propTableOffset + propTableLength)
    idx.propertyTable = parsePropertyTable(propBuf)
  }
  return idx
}

// ═══════════════════════════════════════════════════════════════════
// Phase A: Index parses cleanly + structural invariants
// ═══════════════════════════════════════════════════════════════════

describe('XGVT index: ne_110m_land.xgvt parses cleanly', () => {
  let idx: XGVTIndex
  beforeAll(() => { idx = parseXgvtFromFile(LAND_XGVT_PATH) })

  it('entries list is non-empty', () => {
    expect(idx.entries.length, 'parsed index has no entries').toBeGreaterThan(0)
  })

  it('entryByHash is a Map and covers every entry', () => {
    expect(idx.entryByHash).toBeInstanceOf(Map)
    expect(idx.entryByHash.size).toBe(idx.entries.length)
    for (const e of idx.entries) {
      expect(idx.entryByHash.has(e.tileHash),
        `entry ${e.tileHash} missing from entryByHash`).toBe(true)
    }
  })

  it('zoom levels in the index are a contiguous range starting at z=0', () => {
    // A gap in the zoom ladder means firstIndexedAncestor skips a
    // level. The ancestor found is too coarse and rendering uses a
    // low-detail tile inside a high-zoom viewport — looks like a
    // blurry patch surrounded by "nothing".
    const zooms = new Set<number>()
    for (const e of idx.entries) {
      const [z] = tileKeyUnpack(e.tileHash)
      zooms.add(z)
    }
    const sorted = [...zooms].sort((a, b) => a - b)
    console.log(`[xgvt-land] indexed zoom levels: [${sorted.join(', ')}]`)
    expect(sorted[0], 'indexed levels should start at z=0').toBe(0)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i], `zoom gap at index ${i}: ${sorted[i - 1]} → ${sorted[i]}`)
        .toBe(sorted[i - 1] + 1)
    }
  })

  it('every indexed (x, y) at every zoom z is in-range [0, 2^z)', () => {
    // Out-of-range coords are always a corruption sign — the Hilbert
    // pack/unpack or tileKey arithmetic went wrong on write.
    for (const e of idx.entries) {
      const [z, x, y] = tileKeyUnpack(e.tileHash)
      const n = Math.pow(2, z)
      expect(x >= 0 && x < n, `bad x=${x} at z=${z}`).toBe(true)
      expect(y >= 0 && y < n, `bad y=${y} at z=${z}`).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase B: At the exact bug URL, every frustum tile has a draw path
// ═══════════════════════════════════════════════════════════════════

describe('XGVT pipeline at bug URL: every frustum tile has a draw path', () => {
  let idx: XGVTIndex
  beforeAll(() => { idx = parseXgvtFromFile(LAND_XGVT_PATH) })

  it('visibleTilesFrustum returns a non-empty tile set (re-confirms CPU layer)', () => {
    const tiles = visibleTilesFrustum(makeBugCam(), mercator, Math.round(BUG.zoom), W, H)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('every frustum tile either has a direct index entry OR a reachable ancestor', () => {
    const tiles = visibleTilesFrustum(makeBugCam(), mercator, Math.round(BUG.zoom), W, H)
    const orphans: string[] = []
    const viaAncestor: number[] = []
    const directHits: number[] = []
    for (const t of tiles) {
      const key = tileKey(t.z, t.x, t.y)
      if (idx.entryByHash.has(key)) {
        directHits.push(key)
        continue
      }
      const ancestor = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
      if (ancestor === -1) {
        orphans.push(`${t.z}/${t.x}/${t.y} (key=${key}): no ancestor in index`)
      } else {
        viaAncestor.push(ancestor)
      }
    }
    console.log(
      `[xgvt-land @ bug URL] direct=${directHits.length}, ` +
      `via-ancestor=${viaAncestor.length}, ` +
      `orphaned=${orphans.length} / total=${tiles.length}`,
    )
    // The contract: ZERO orphans. If any frustum tile has no ancestor
    // in the index, the user will see a blank patch regardless of
    // what the renderer/loader do downstream.
    expect(
      orphans,
      `orphaned frustum tiles:\n  ${orphans.join('\n  ')}`,
    ).toEqual([])
  })

  it('ancestor tiles used at the bug URL are at the deepest available zoom', () => {
    // Detail-quality oracle. If every frustum tile's ancestor is z=0,
    // the renderer shows a single world-wide tile inside the user's
    // z=10 viewport — the geometry is technically "loaded" but shows
    // as a giant featureless color block. That's the user perception
    // of "nothing loaded".
    const tiles = visibleTilesFrustum(makeBugCam(), mercator, Math.round(BUG.zoom), W, H)

    // First: compute the deepest zoom the index carries.
    let maxIndexedZ = 0
    for (const e of idx.entries) {
      const [z] = tileKeyUnpack(e.tileHash)
      if (z > maxIndexedZ) maxIndexedZ = z
    }

    const ancestorZooms: number[] = []
    for (const t of tiles) {
      const key = tileKey(t.z, t.x, t.y)
      if (idx.entryByHash.has(key)) {
        ancestorZooms.push(t.z)
        continue
      }
      const ancestor = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
      if (ancestor === -1) continue
      const [az] = tileKeyUnpack(ancestor)
      ancestorZooms.push(az)
    }

    const mean = ancestorZooms.reduce((s, z) => s + z, 0) / Math.max(ancestorZooms.length, 1)
    const minAncZ = Math.min(...ancestorZooms)
    const maxAncZ = Math.max(...ancestorZooms)
    console.log(
      `[xgvt-land @ bug URL] ancestor zooms: min=${minAncZ}, max=${maxAncZ}, ` +
      `mean=${mean.toFixed(2)} (source maxIndexedZ=${maxIndexedZ})`,
    )
    // If the source indexes up to z=N, we expect ancestors to reach
    // z=N for at least ONE frustum tile near camera center. If even
    // that fails, `firstIndexedAncestor` isn't finding the deepest
    // available level — an ancestor-walk bug.
    expect(maxAncZ, 'no frustum tile reaches the source max-indexed zoom')
      .toBe(maxIndexedZ)
  })

  it('orphan count is zero across all integer zooms 0..18 at the bug lat/lon + pitch', () => {
    // Zoom axis sweep. The user's URL uses zoom=10.29 → maxZ=10. If a
    // user zooms in further, does the orphan count stay zero? If it
    // grows at some zoom transition, we've found the exact "zoom
    // threshold at which tiles stop loading".
    const orphansByZoom: Array<{ zoom: number; orphans: number; tiles: number }> = []
    for (let zoom = 0; zoom <= 18; zoom++) {
      const cam = new Camera(BUG.lon, BUG.lat, zoom)
      cam.pitch = BUG.pitch
      cam.bearing = BUG.bearing
      const tiles = visibleTilesFrustum(cam, mercator, zoom, W, H)
      let orphans = 0
      for (const t of tiles) {
        const key = tileKey(t.z, t.x, t.y)
        if (idx.entryByHash.has(key)) continue
        const a = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
        if (a === -1) orphans++
      }
      orphansByZoom.push({ zoom, orphans, tiles: tiles.length })
    }
    const bad = orphansByZoom.filter(r => r.orphans > 0)
    if (bad.length > 0) {
      const table = orphansByZoom
        .map(r => `  z=${r.zoom.toString().padStart(2)}: ${r.orphans}/${r.tiles} orphans`)
        .join('\n')
      console.log('[xgvt-land @ bug lat/lon + pitch=84] orphan table:\n' + table)
    }
    expect(bad, 'zooms with at least one orphan tile').toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase C: All four physical-map-50m sources share this contract
// ═══════════════════════════════════════════════════════════════════

describe('XGVT pipeline at bug URL: all four physical_map_50m sources deliver', () => {
  const SOURCES = [
    'ne_110m_ocean.xgvt',
    'ne_110m_land.xgvt',
    'ne_50m_rivers.xgvt',
    'ne_50m_lakes.xgvt',
  ] as const

  for (const name of SOURCES) {
    it(`${name}: every frustum tile at bug URL has a draw path`, () => {
      const idx = parseXgvtFromFile(resolve(DATA_DIR, name))
      const tiles = visibleTilesFrustum(makeBugCam(), mercator, Math.round(BUG.zoom), W, H)

      const orphans: string[] = []
      for (const t of tiles) {
        const key = tileKey(t.z, t.x, t.y)
        if (idx.entryByHash.has(key)) continue
        const a = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
        if (a === -1) orphans.push(`${t.z}/${t.x}/${t.y}`)
      }
      expect(
        orphans,
        `${name}: ${orphans.length} orphaned tiles:\n  ${orphans.join('\n  ')}`,
      ).toEqual([])
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase D: Pitch-parameterized bulk check — other high-pitch URLs
// ═══════════════════════════════════════════════════════════════════

describe('XGVT pipeline (land): pitch × location matrix', () => {
  // Rule out location-specific bugs (antimeridian, pole, etc.).
  const LOCATIONS: Array<[string, number, number]> = [
    ['bug-china',     117.95751,  30.94565],
    ['paris',         2.3522,     48.8566],
    ['tokyo',         139.6917,   35.6895],
    ['new-york',      -74.0060,   40.7128],
    ['antimeridian',  179.0,      0.0],
    ['equator',       0.0,        0.0],
  ]

  let idx: XGVTIndex
  beforeAll(() => { idx = parseXgvtFromFile(LAND_XGVT_PATH) })

  for (const pitch of [70, 80, 84, 87]) {
    for (const [label, lon, lat] of LOCATIONS) {
      it(`${label} pitch=${pitch}: no orphan frustum tiles`, () => {
        const cam = new Camera(lon, lat, 10)
        cam.pitch = pitch
        cam.bearing = 0
        const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
        expect(tiles.length, `${label} p=${pitch}: 0 tiles`).toBeGreaterThan(0)

        const orphans: string[] = []
        for (const t of tiles) {
          const key = tileKey(t.z, t.x, t.y)
          if (idx.entryByHash.has(key)) continue
          const a = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
          if (a === -1) orphans.push(`${t.z}/${t.x}/${t.y}`)
        }
        expect(
          orphans,
          `${label} p=${pitch}: ${orphans.length} orphans:\n  ${orphans.join('\n  ')}`,
        ).toEqual([])
      })
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase E: firstIndexedAncestor never exceeds its walk cap
// ═══════════════════════════════════════════════════════════════════

describe('XGVT pipeline: firstIndexedAncestor walks bounded', () => {
  let idx: XGVTIndex
  beforeAll(() => { idx = parseXgvtFromFile(LAND_XGVT_PATH) })

  it('at every frustum tile of the bug URL, ancestor walk terminates in ≤ (leafZ - rootZ) steps', () => {
    const tiles = visibleTilesFrustum(makeBugCam(), mercator, Math.round(BUG.zoom), W, H)
    // `firstIndexedAncestor` has MAX_WALK=22. A tile at z=10 walks at
    // most 10 steps. Verify the walk count never exceeds the leaf's
    // depth — detects infinite-loop regressions in the parent step.
    for (const t of tiles) {
      const key = tileKey(t.z, t.x, t.y)
      let walkCount = 0
      const hasEntry = (k: number): boolean => {
        walkCount++
        return idx.entryByHash.has(k)
      }
      firstIndexedAncestor(key, hasEntry)
      expect(walkCount,
        `ancestor walk at ${t.z}/${t.x}/${t.y} exceeded leaf depth (z=${t.z})`,
      ).toBeLessThanOrEqual(t.z + 1)
    }
  })
})

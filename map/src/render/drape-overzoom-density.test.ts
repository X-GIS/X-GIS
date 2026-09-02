// ═══ #2346 — the windowed bake engages on TEXEL DENSITY, not on the source max ═══
//
// #2024 built the right mechanism (virtual sub-tiles, each a full-resolution
// windowed bake of a resident ancestor) and gated it on `currentZ ===
// source.maxLevel`, with no `dpr` input and a floor()'d camera zoom — so it only
// ever ran PAST the source's deepest level. Everything inside the source range
// kept one 512px bake magnified across the tile: at dpr 2 that is a 2× upscale at
// NATIVE zoom, which is the blur the owner reported against the Mercator control.
//
// These tests drive the real `computeDrapeOverzoom` against the real
// `globeVisibleTiles`, so they pin the POLICY (when it engages, and which tile it
// windows) rather than a restatement of the arithmetic. The window math itself is
// pinned by vector-drape-overzoom.test.ts.

import { describe, it, expect } from 'vitest'
import { computeDrapeOverzoom } from './drape-overzoom-dispatch'
import { globeVisibleTiles } from '@xgis/data'
import { tileKey, tileKeyUnpack } from '@xgis/compiler'
import { activeBody } from '@xgis/shared'

const PROJ_GLOBE = 7
const W = 1024
const H = 720
const CENTER_LON = 126.81412
const CENTER_LAT = 37.54704

/** camera.centerX is Mercator metres on the sphere radius; the globe reads its
 *  true centre latitude from `centerLatDeg` (representsCenterAs(7)). */
function globeCamera(zoom: number) {
  return {
    zoom,
    centerX: (CENTER_LON * Math.PI * activeBody().sphereR) / 180,
    centerLatDeg: CENTER_LAT,
    pitch: 0,
    bearing: 0,
  }
}

/** The keys the primary selection draws at `currentZ` — the same selector the
 *  render path uses, so `neededKeys` in the tests is what the renderer really
 *  hands the dispatch. */
function drawnKeys(zoom: number, currentZ: number): number[] {
  return globeVisibleTiles(CENTER_LON, CENTER_LAT, zoom, currentZ, W, H, 0, 0).map((t) =>
    tileKey(t.z, t.x, t.y),
  )
}

function run(o: {
  zoom: number
  currentZ: number
  dpr: number
  maxLevel: number
  neededKeys?: number[]
  resident?: Set<number>
  projType?: number
}) {
  const needed = o.neededKeys ?? drawnKeys(o.zoom, o.currentZ)
  const resident = o.resident ?? new Set(needed)
  const requested: number[] = []
  const uploaded: number[] = []
  const out = computeDrapeOverzoom({
    camera: globeCamera(o.zoom),
    projType: o.projType ?? PROJ_GLOBE,
    currentZ: o.currentZ,
    cssWidth: W,
    cssHeight: H,
    dpr: o.dpr,
    source: {
      maxLevel: o.maxLevel,
      // Everything the walk asks for exists in the catalog but is not on the GPU
      // unless `resident` says so — the "compiled but never uploaded" branch.
      hasTileData: () => true,
      requestTiles: (keys) => requested.push(...keys),
    },
    sliceLayer: '',
    neededKeys: needed,
    layerCache: { has: (k) => resident.has(k) },
    uploadResident: (k) => uploaded.push(k),
  })
  return { out, needed, requested, uploaded }
}

describe('#2346 — the drape windows by device-pixel density', () => {
  it('dpr 1 at native zoom: nothing to window (the bake is already at device density)', () => {
    // One bake texel per CSS px per device px — windowing would only cost draw
    // calls. This is the case that must stay byte-identical to before #2346.
    expect(run({ zoom: 4, currentZ: 4, dpr: 1, maxLevel: 14 }).out).toBeUndefined()
    expect(run({ zoom: 4.4, currentZ: 4, dpr: 1, maxLevel: 14 }).out).toBeUndefined()
  })

  it('dpr 2 INSIDE the source range: engages one level deeper — the case #2024 could not see', () => {
    // The report's shape: a 2× display, a camera nowhere near the source maximum.
    // Pre-#2346 this returned undefined (`currentZ !== srcMaxLevel`) and the frame
    // drew one 512px bake stretched over 2·TILE_PX device px.
    const { out, needed } = run({ zoom: 4.4, currentZ: 4, dpr: 2, maxLevel: 14 })
    expect(out, 'dpr 2 must reach a deeper virtual level than the drawn one').toBeDefined()
    expect(out!.length).toBeGreaterThan(0)
    for (const t of out!) {
      expect(t.z, 'virtual tiles sit one level below the device zoom').toBe(5)
      expect(
        needed.includes(t.parentKey),
        'every virtual tile must window a tile the PRIMARY selection is drawing — windowing ' +
          'anything else changes what is on screen, or fetches a level the camera never asked for',
      ).toBe(true)
      const [pz, px, py] = tileKeyUnpack(t.parentKey)
      expect(pz, 'the drawn ancestor is at the selection LOD').toBe(4)
      // Containment: the virtual tile is inside the parent it windows.
      expect(t.x >> (t.z - pz)).toBe(px)
      expect(t.y >> (t.z - pz)).toBe(py)
    }
  })

  it('the virtual level follows dpr, not the source', () => {
    // Each doubling of dpr is one octave of texel demand.
    const z = (dpr: number) => {
      const r = run({ zoom: 4.4, currentZ: 4, dpr, maxLevel: 14 })
      return r.out?.[0]?.z
    }
    expect(z(1)).toBeUndefined()
    expect(z(2)).toBe(5)
    expect(z(4)).toBe(6)
  })

  it('over-zoom is unchanged: the ancestor is the maxLevel tile the selection drew (#2024)', () => {
    // currentZ === maxLevel is the case #2024 shipped for; `neededKeys` IS the
    // maxLevel set there, so the drawn-ancestor mapping reduces to its own.
    const { out, needed } = run({ zoom: 10.3, currentZ: 2, dpr: 1, maxLevel: 2 })
    expect(out).toBeDefined()
    expect(out!.length).toBeGreaterThan(0)
    for (const t of out!) {
      expect(t.z).toBeGreaterThan(2)
      expect(needed.includes(t.parentKey)).toBe(true)
      expect(tileKeyUnpack(t.parentKey)[0]).toBe(2)
    }
  })

  it('holds the switch — and fetches — while a virtual tile has no drawn ancestor on the GPU', () => {
    // The atomic parent→virtual switch (#2024): mixed parent and child cover
    // double-blends translucent fills, so a single missing ancestor must keep the
    // whole frame on the parent path. Nothing resident ⇒ undefined, and the
    // deepest candidates are uploaded/requested so the next frame can switch.
    const r = run({ zoom: 10.3, currentZ: 2, dpr: 1, maxLevel: 2, resident: new Set() })
    expect(r.out).toBeUndefined()
    expect(r.uploaded.length + r.requested.length).toBeGreaterThan(0)
  })

  it('never engages off the globe route, or on a source with no levels', () => {
    expect(run({ zoom: 4.4, currentZ: 4, dpr: 2, maxLevel: 14, projType: 0 }).out).toBeUndefined()
    expect(run({ zoom: 4.4, currentZ: 0, dpr: 2, maxLevel: 0 }).out).toBeUndefined()
  })
})

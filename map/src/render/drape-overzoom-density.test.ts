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
import { computeDrapeOverzoom, type DrapeOverzoomDiag } from './drape-overzoom-dispatch'
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

function run(
  o: {
    zoom: number
    currentZ: number
    dpr: number
    maxLevel: number
    neededKeys?: number[]
    resident?: Set<number>
    projType?: number
  },
  diag?: DrapeOverzoomDiag,
) {
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
    diag,
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
  it('stays off exactly where the bake is ALREADY at device density', () => {
    // dpr 1 at an integer camera zoom is the one case where one bake texel is
    // one device pixel — windowing would only cost draw calls, and this frame
    // must stay byte-identical to before #2346.
    expect(run({ zoom: 4, currentZ: 4, dpr: 1, maxLevel: 14 }).out).toBeUndefined()
    // dpr 1 at a fractional zoom is a 1.32× upscale, but the deepest level the
    // selector's footprint branch can serve is floor(4.4) = 4 — the drawn level
    // itself. Nothing to window; the residual is the pre-existing ≤2× and is not
    // the reported case (which is dpr 2, where the octave lifts the floor).
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
      expect(
        t.z,
        'deviceZoom 5.4 rounds to 5 — the level at which one bake texel covers about one ' +
          'device pixel (1.32× oversampled here)',
      ).toBe(5)
      expect(
        needed.includes(t.parentKey),
        'every virtual tile must window a tile the PRIMARY selection is drawing — windowing ' +
          'anything else changes what is on screen, or fetches a level the camera never asked for',
      ).toBe(true)
      const [pz, px, py] = tileKeyUnpack(t.parentKey)
      expect(pz, 'the drawn ancestor is at the selection LOD').toBe(4)
      expect(t.z - pz, 'one level of subdivision: the dpr octave').toBe(1)
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
    // deviceZoom 4.4 / 5.4 / 6.4 → rounded to nearest 4 / 5 / 6; at dpr 1 that is
    // the drawn level itself, so there is nothing to window.
    expect(z(1)).toBeUndefined()
    expect(z(2)).toBe(5)
    expect(z(4)).toBe(6)
  })

  it('rounds to NEAREST: past the half-octave the set splits in place, 4× the entries', () => {
    // deviceZoom 5.4 (below the half) stays at 5; 5.6 (past it) splits to 6. The
    // split is local — same parents, four children each — so it costs entries,
    // never a second selection pass, and never over-subdivides the horizon.
    const below = run({ zoom: 4.4, currentZ: 4, dpr: 2, maxLevel: 14 })
    const above = run({ zoom: 4.6, currentZ: 4, dpr: 2, maxLevel: 14 })
    expect(below.out![0]!.z).toBe(5)
    expect(above.out![0]!.z).toBe(6)
    // Structural: the split set is EXACTLY a 4-way subdivision — every tile has
    // its three siblings, so nothing was re-selected, dropped or duplicated.
    // (The two cameras differ, so the raw counts are not comparable; the shape
    // is.)
    const groups = new Map<string, number>()
    for (const t of above.out!) {
      const k = `${t.z - 1}/${t.x >> 1}/${t.y >> 1}`
      groups.set(k, (groups.get(k) ?? 0) + 1)
    }
    expect(above.out!.length % 4, 'a 4-way split cannot leave a remainder').toBe(0)
    expect(groups.size, 'four children per split parent').toBe(above.out!.length / 4)
    for (const [k, n] of groups) expect(n, `group ${k} is missing siblings`).toBe(4)
    // Every child still windows the SAME drawn ancestor as its parent did.
    for (const t of above.out!) expect(above.needed.includes(t.parentKey)).toBe(true)
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

describe('#2346 — an exact-integer device zoom is the case that needs windowing MOST', () => {
  // camera 5.0 on a 2× display → deviceZoom exactly 6.0. The selector's footprint
  // branch only serves a level strictly below that, so the level asked for drops
  // to 5 — and comparing THAT against the drawn LOD 5 read as "nothing deeper to
  // do" and turned the whole rule off, at precisely the camera where a 512px bake
  // is stretched over 2·TILE_PX device pixels. Measured before this: 0 virtual
  // bakes at z5/dpr2 and a draped frame 12.5 % away from the direct one, against
  // 0.65-1.9 % at z3.5 and z2 where the rule did engage.
  it('engages at camera 5.0 / dpr 2, at the level the split lifts it back to', () => {
    const { out } = run({ zoom: 5, currentZ: 5, dpr: 2, maxLevel: 14 })
    expect(out, 'deviceZoom 6.0 must still window — the bake is a 2× upscale there').toBeDefined()
    for (const t of out!) expect(t.z, 'selected at 5, split back up to 6').toBe(6)
  })

  it('the diagnostic reports the EFFECTIVE level, not the pre-split one', () => {
    // A reader that sees `virtualZ: 5` next to `currentZ: 5` cannot tell an
    // engaged frame from a no-op one — which is how this stayed invisible.
    const diag: DrapeOverzoomDiag = {}
    run({ zoom: 5, currentZ: 5, dpr: 2, maxLevel: 14 }, diag)
    expect(diag.virtualZ).toBe(6)
    expect(diag.reason).toBe('engaged')
    expect(diag.split).toBe(true)
  })

  it('still declines when even the split cannot get deeper than the drawn LOD', () => {
    // dpr 1 at an integer camera zoom: deviceZoom 5.0 → select 4, split to 5 =
    // the drawn LOD. One bake texel is already one device pixel; windowing would
    // only cost draw calls.
    expect(run({ zoom: 5, currentZ: 5, dpr: 1, maxLevel: 14 }).out).toBeUndefined()
  })
})

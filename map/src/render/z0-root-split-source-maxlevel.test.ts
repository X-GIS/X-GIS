// #1792 — the non-Mercator z=0 root-tile split must respect the source's maxLevel.
//
// `TileSelectionCache.selectForFrame` REPLACES the z=0 root with its four z=1
// children on every projType that is neither Mercator nor globe, to force the
// archive's clip stage to cut antimeridian-crossing rings apart
// (tile-selection-cache.ts, "Non-Mercator z=0 root-tile split"). On a source
// whose archive STOPS at z=0 that swap replaces the source's ONLY tile with four
// keys that can never resolve: the whole selection classifies as over-zoom and
// the source draws nothing.
//
// The production victim is the synthetic earth-surface show
// (`SyntheticEarthSurfaceBackend` declares `maxZoom: 0` on its own dedicated
// catalog — map.ts `_installSyntheticEarthSurfaceSource`), which is what paints
// the style's `background-color` over the sphere. Measured on the #1495 mirror
// probe: `__synthetic_earth_surface__` issued 2 draw calls on mercator, 1 on
// `?proj=globe` — the two projTypes this branch EXCLUDES — and 0 on
// orthographic / stereographic, so the ocean stayed at the sphere-full black
// clear while every deeper source drew over it. The z=0-only per-source polar
// cap (`geojson-polar-cap-backend`, also `maxZoom: 0`) is the same shape.
//
// Why the assertions run cause-then-effect (CLAUDE.md §12): the CAUSE is "the
// z=0 root survived selection"; the EFFECT is "no tile is classified over-zoom"
// (`parentAtMaxLevel[i] >= 0`), which is the state that makes the forced-WebGL2
// fills path draw nothing at all — `renderFillsRhi` is primary-only acquisition
// with no fallback-ancestor pass (#1140), so an all-over-zoom selection is zero
// draw calls there. Asserting the effect first would let a red run accuse the
// wrong half.
//
// The equirectangular pair is a same-camera A/B in which ONLY `source.maxLevel`
// differs, so nothing but the guard can explain a difference between them — and
// the deep-source arm is the control that fails if the split is ever "fixed" by
// deletion. No GPU: this reads selector output only.

import { describe, expect, it } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import { tileKey } from '@xgis/compiler'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

const CANVAS_W = 1024
const CANVAS_H = 768
const DPR = 1

/** The azimuthal disc-detail selection floor (#1791, tile-selection-cache.ts).
 *  Below it the sphere arm's selection max level is boosted past the source's
 *  own — a DIFFERENT defect. Asserted against below so this test cannot drift
 *  into measuring that one instead. */
const DISC_DETAIL_FLOOR = Math.log2(Math.max(CANVAS_W, CANVAS_H) / DPR / 128)

/** Camera zoom for the sphere (orthographic) arm — at or above the disc-detail
 *  floor, so the #1791 boost is a strict no-op and the split is the only thing
 *  acting on this selection. */
const SPHERE_ZOOM = 4

/** Camera zoom for the flat arms. `currentZ` resolves to `floor(zoom)` = 0,
 *  which is what makes the flat SSE selector emit the z=0 root at all. */
const FLAT_ZOOM = 0

const Z0_KEY = tileKey(0, 0, 0)

// Minimal catalog — the same surface `tile-selection-lru.test.ts` uses.
// `hasEntryInIndex: false` keeps the ancestor walk inert; no layer range means
// no per-layer zoom cull.
function fakeCatalog(maxLevel: number): TileCatalog {
  const catalog = {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
    indexGeneration: () => 0,
  }
  return catalog as unknown as TileCatalog
}

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

function select(projType: number, maxLevel: number, camera: Camera) {
  const source = fakeCatalog(maxLevel)
  return new TileSelectionCache().selectForFrame(
    camera,
    projType,
    // projCenterLon / projCenterLat feed the camera signature and the flat
    // selectorProj's centre; the sphere branch reads the camera's own centre
    // (centerX / centerLatDeg), so 0/0 is inert for the orthographic arm.
    0,
    0,
    CANVAS_W,
    CANVAS_H,
    DPR,
    1, // frameId
    source,
    '', // no sliceLayer → skip the per-layer minzoom cull
    2, // marginPx
    maxLevel,
    NO_STATS,
  )
}

/** `z/x/y` list for a failure message — the tiles that replaced the root. */
function coords(sel: { tiles: Array<{ z: number; x: number; y: number }> }): string {
  return sel.tiles.map((t) => `${t.z}/${t.x}/${t.y}`).join(' ')
}

describe('#1792 — the z=0 root split must respect the source maxLevel', () => {
  it('premise: the sphere arm runs at or above the #1791 disc-detail floor', () => {
    // Without this the orthographic arm below would be measuring the disc-detail
    // boost's over-select instead of the split, and would stay red for a reason
    // this test does not name.
    expect(SPHERE_ZOOM).toBeGreaterThanOrEqual(DISC_DETAIL_FLOOR)
  })

  it('orthographic (sphere-routed): a z=0-only source keeps its z=0 root', () => {
    const camera = new Camera(140, 20, SPHERE_ZOOM)
    const sel = select(3, 0, camera)
    expect(sel, 'selectForFrame returned null').not.toBeNull()

    // CAUSE — the source's one and only tile survived selection. Pre-fix the
    // split swapped it for four z=1 children, so this is the assertion that goes
    // red, and its message names the tiles that replaced the root.
    expect(sel!.neededKeys, `z=0 root dropped; selection is [${coords(sel!)}]`).toContain(Z0_KEY)

    // EFFECT — nothing is classified over-zoom, which is what lets the
    // primary-only forced-WebGL2 fills path draw at all.
    const overZoom = sel!.parentAtMaxLevel.filter((p) => p >= 0).length
    expect(overZoom, 'tiles classified over-zoom against a maxLevel-0 source').toBe(0)
    expect(sel!.tiles.every((t) => t.z === 0)).toBe(true)
  })

  it('equirectangular (flat-routed): a z=0-only source keeps its z=0 root', () => {
    const camera = new Camera(0, 0, FLAT_ZOOM)
    const sel = select(1, 0, camera)
    expect(sel, 'selectForFrame returned null').not.toBeNull()

    expect(sel!.neededKeys, `z=0 root dropped; selection is [${coords(sel!)}]`).toContain(Z0_KEY)
    const overZoom = sel!.parentAtMaxLevel.filter((p) => p >= 0).length
    expect(overZoom, 'tiles classified over-zoom against a maxLevel-0 source').toBe(0)
    expect(sel!.tiles.every((t) => t.z === 0)).toBe(true)
  })

  it('CONTROL — equirectangular with a DEEP source still splits the root into z=1', () => {
    // Same projType, same camera, same canvas as the arm above: `source.maxLevel`
    // is the ONLY input that differs, so this pair isolates the guard exactly. It
    // is also the assertion that fails if #1792 is ever "fixed" by deleting the
    // split — the antimeridian smear that split kills is real for any source with
    // a z=1 level to clip against.
    const camera = new Camera(0, 0, FLAT_ZOOM)
    const sel = select(1, 4, camera)
    expect(sel, 'selectForFrame returned null').not.toBeNull()

    expect(
      sel!.tiles.some((t) => t.z === 0),
      `the z=0 root survived on a deep source — the split stopped running: [${coords(sel!)}]`,
    ).toBe(false)
    // The four children the split substitutes, in the primary world copy.
    const quad: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]
    for (const [x, y] of quad) {
      const present = sel!.tiles.some((t) => t.z === 1 && t.x === x && t.y === y && t.ox === x)
      expect(present, `z=1/${x}/${y} missing — the split emitted a partial quad`).toBe(true)
    }
  })

  it('CONTROL — mercator never splits, which is why a z=0-only source drew there', () => {
    // The measured control arm from the issue: `__synthetic_earth_surface__`
    // issued 2 draw calls on mercator against 0 on the azimuthal family. Mercator
    // is excluded from the split by `isMercatorProj`, which is precisely why it
    // never showed the bug — green before and after the fix.
    const camera = new Camera(140, 20, FLAT_ZOOM)
    const sel = select(0, 0, camera)
    expect(sel, 'selectForFrame returned null').not.toBeNull()
    expect(sel!.neededKeys).toContain(Z0_KEY)
    expect(sel!.parentAtMaxLevel.filter((p) => p >= 0).length).toBe(0)
  })
})

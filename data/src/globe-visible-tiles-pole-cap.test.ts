// Issue #469 — the per-source polar cap (a maxZoom=0 global tile whose
// geometry lives at the pole, lat > MERCATOR_LAT_LIMIT) must be SELECTED when
// the globe camera targets the pole, or the ±5° pole disc renders black.
//
// A cap source's selector maxZ is clamped to its maxLevel (0) by the tile-
// selection cache, so the cap calls globeVisibleTiles(..., maxZ = 0). At a
// zoomed-in pole view the overzoom footprint branch degenerates (the pole is a
// longitude singularity → the unprojected lon span blows past the guard) and
// the legacy descent's only candidate, the z=0 root, is dropped: its ±85.05°
// corner samples fall outside the small visible pole cap (anyFront = false) and
// centerLat = 90 exceeds every Mercator tile's north edge (containsTarget =
// false). Result: ZERO tiles for the cap → the cap draws nothing → black hole.
//
// These tests pin the coverage rule at the selector level: when the camera
// targets a pole, the pole-owning root tile must be emitted so a maxLevel=0 cap
// source renders. FAIL-BEFORE on current main (empty / no pole tile).

import { describe, it, expect } from 'vitest'
import { globeVisibleTiles } from './globe-visible-tiles'

// The polar-cap backend clamps its own selection to maxZoom = 0, so the
// selector is invoked with maxZ = 0 at the camera's true zoom. 900×900 is the
// viewport the issue's repro (jumpTo({center:[0,90], zoom:4.5})) uses.
const CAP_MAXZ = 0

describe('globeVisibleTiles — polar-cap coverage at the pole (issue #469)', () => {
  it('emits the z=0 root for a maxZ=0 cap source at a zoomed-in NORTH pole view', () => {
    const tiles = globeVisibleTiles(0, 90, 4.5, CAP_MAXZ, 900, 900, 0, 0)
    // The cap's only tile is (0,0,0); it must be in the selection or the ±5°
    // hole is black. On main this array is empty.
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0)).toBe(true)
  })

  it('emits the z=0 root for a maxZ=0 cap source at a zoomed-in SOUTH pole view (metamorphic)', () => {
    const tiles = globeVisibleTiles(0, -90, 4.5, CAP_MAXZ, 900, 900, 0, 0)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0)).toBe(true)
  })

  it('still emits the root across a range of pole-view zooms (3.5 … 6)', () => {
    for (const zoom of [3.5, 4.5, 5.5, 6]) {
      const tiles = globeVisibleTiles(0, 90, zoom, CAP_MAXZ, 900, 900, 0, 0)
      expect(
        tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0),
        `zoom ${zoom} must select the cap root`,
      ).toBe(true)
    }
  })

  it('does NOT force the root into a normal mid-latitude view (no over-selection)', () => {
    // Guard: the pole rule must not leak into ordinary views. At lat 20°, a
    // high-maxZ source selects detailed tiles, never the whole-world root.
    const tiles = globeVisibleTiles(0, 20, 4.5, 6, 900, 900, 0, 0)
    expect(tiles.some((t) => t.z === 0)).toBe(false)
  })

  it('a high-maxZ source at the pole descends the pole column, never emitting the whole-world root', () => {
    // Blast-radius guard: only a maxLevel=0 cap (maxZ=0) draws the coarse root
    // at the pole. A detailed source (maxZ=6, e.g. the tiled ocean itself)
    // force-descends the pole column to its leaf level — it must NOT gain the
    // z=0 whole-world tile (that would double-draw a coarse layer under the
    // rim tiles). Confirms the fix adds pole coverage for caps without changing
    // what normal sources render at the pole.
    const tiles = globeVisibleTiles(0, 90, 4.5, 6, 900, 900, 0, 0)
    expect(tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0)).toBe(false)
    // The pole-edge row (y=0) IS reached at the leaf level so the pole is covered.
    expect(tiles.some((t) => t.y === 0)).toBe(true)
  })
})

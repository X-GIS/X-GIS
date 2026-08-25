import { describe, it, expect } from 'vitest'
import {
  PROJECTIONS,
  PROJECTION_NAME_TO_TYPE,
  SELECTOR_PROJ_NAMES,
  poleLimit,
  representsCenterAs,
  worldCopiesFor,
  enumerateWorldCopies,
  routeToSphereSelector,
  bakesVectorDrape,
  GLOBE_DIRECT_MIN_SELECTION_Z,
  drapesAtSelectionZ,
} from './projections-table'
import { MERCATOR_LAT_LIMIT } from './projection'
import { TILE_PX } from './world-scale'

// The PROJECTIONS table is the SINGLE SOURCE OF TRUTH (authority flip, P1):
// the world-copy / sphere-routing predicates now DERIVE from these rows.
// These tests pin every table field — and the derived predicates — to their
// intended LITERAL value (not to their own derivation), so the table can
// never drift from real runtime behavior. (worldCopiesFor /
// enumerateWorldCopies / routeToSphereSelector are imported from gpu-shared
// to also exercise its re-export of the relocated predicates.)

describe('PROJECTIONS table', () => {
  it('is ordered so index === projType for every record', () => {
    PROJECTIONS.forEach((p, i) => expect(p.projType).toBe(i))
  })

  it('covers exactly the 8 known projections in wire order', () => {
    expect(PROJECTIONS.map((p) => p.name)).toEqual([
      'mercator',
      'equirectangular',
      'natural_earth',
      'orthographic',
      'azimuthal_equidistant',
      'stereographic',
      'oblique_mercator',
      'globe',
    ])
  })

  it('PROJECTION_NAME_TO_TYPE reproduces the prior render-loop literal map', () => {
    // Regression pin: the exact object that render-loop.ts hand-encoded
    // before deriving it from the table.
    expect(PROJECTION_NAME_TO_TYPE).toEqual({
      mercator: 0,
      equirectangular: 1,
      natural_earth: 2,
      orthographic: 3,
      azimuthal_equidistant: 4,
      stereographic: 5,
      oblique_mercator: 6,
      globe: 7,
    })
  })

  it('SELECTOR_PROJ_NAMES reproduces the prior VTR int→name array (globe excluded)', () => {
    expect(SELECTOR_PROJ_NAMES).toEqual([
      'mercator',
      'equirectangular',
      'natural_earth',
      'orthographic',
      'azimuthal_equidistant',
      'stereographic',
      'oblique_mercator',
    ])
  })

  it('worldCopies === the ±2 multi-world set for the periodic family {0,1,2,6}, single otherwise', () => {
    const multiWorld = new Set([0, 1, 2, 6]) // mercator / equirect / NE / oblique
    for (const p of PROJECTIONS) {
      expect(p.worldCopies).toEqual(multiWorld.has(p.projType) ? [-2, -1, 0, 1, 2] : [0])
    }
  })

  it('worldCopiesFor() derives that set from the table (re-export pinned)', () => {
    for (const p of PROJECTIONS) {
      expect(worldCopiesFor(p.projType)).toEqual(p.worldCopies)
    }
  })

  it('periodic === the world-copy-enumerated set {1,2,6} (mercator is flat-routed)', () => {
    for (const p of PROJECTIONS) {
      expect(p.periodic).toBe([1, 2, 6].includes(p.projType))
    }
  })

  it('enumerateWorldCopies is gated above WORLD_COPY_MAX_ZOOM (off below the gate, on within)', () => {
    for (const p of PROJECTIONS) {
      expect(enumerateWorldCopies(p.projType, 4)).toBe(p.periodic) // z≤4: tracks periodic
      expect(enumerateWorldCopies(p.projType, 5)).toBe(false) // z>4: neighbours off-canvas
    }
  })

  it('routeToSphereSelector === {3,4,5,6} (derived !isFlat && !isGlobe), ∪ globeMode', () => {
    for (const p of PROJECTIONS) {
      expect(routeToSphereSelector(p.projType, false)).toBe([3, 4, 5, 6].includes(p.projType))
      expect(routeToSphereSelector(p.projType, true)).toBe(true) // globeMode forces sphere routing
    }
  })

  // ── bakesVectorDrape: #599 vector bake→drape routing predicate ──
  // T3 (post-flip pin): bakesVectorDrape drapes only the sphere-surface family
  // {3,4,5} (∪ globeMode) — oblique(6) is EXCLUDED. routeToSphereSelector is
  // UNCHANGED ({3,4,5,6}∪globeMode, pinned above): the whole fix is that tile
  // SELECTION still sphere-routes 6 while the render SURFACE no longer drapes it.
  // (Supersedes the T1 extraction pin — bakesVectorDrape===routeToSphereSelector —
  // which held only before the oblique(6) exclusion flip.)
  it('T3: bakesVectorDrape === {3,4,5} ∪ globeMode (oblique(6) excluded from drape)', () => {
    for (const p of PROJECTIONS) {
      expect(bakesVectorDrape(p.projType, false)).toBe([3, 4, 5].includes(p.projType))
      expect(bakesVectorDrape(p.projType, true)).toBe(true) // globeMode forces the sphere surface
    }
  })

  // T2 (fail-first witness): oblique_mercator(6) must NOT bake→drape. It is
  // cylindrical + flat-MVP at every pitch (H1 flat-vs-sphere camera agreement
  // ≤4.0px @pitch15 / 7.1px @pitch60 on 2582–4926px tiles, ~0.15%, NOT pitch-
  // gated — refuted), so its 512px native-z14 bake is displayed at 2582–4926px
  // (5.04–9.6× magnification) at the user repro (lon126.9225 lat37.1269 z16.6
  // pitch15, 1920×945, OFM source maxZ=14) — a softness that never heals past
  // the z14 source ceiling (H2 confirmed). Tile SELECTION is unchanged
  // (routeToSphereSelector(6)=true, pinned above); only render SURFACE curvature.
  it('T2 witness: oblique_mercator(6) does NOT bake→drape (renders direct)', () => {
    expect(
      bakesVectorDrape(6, false),
      'oblique(6) fills must render through the direct flat-oblique arm, not the ' +
        '512px native-z14 bake shown at 2582–4926px (5.04–9.6× magnification, non-healing)',
    ).toBe(false)
  })

  it('isCylindrical === multi-world (worldCopiesFor length > 1)', () => {
    for (const p of PROJECTIONS) {
      expect(p.isCylindrical).toBe(worldCopiesFor(p.projType).length > 1)
    }
  })

  it('isFlat === WGSL no-cull flat branch (projType ≤ 2)', () => {
    for (const p of PROJECTIONS) expect(p.isFlat).toBe(p.projType <= 2)
  })

  it('isSeam === antimeridian-seam set {1,2,6}', () => {
    for (const p of PROJECTIONS) {
      expect(p.isSeam).toBe([1, 2, 6].includes(p.projType))
    }
  })

  it('isGlobe === projType 7', () => {
    for (const p of PROJECTIONS) expect(p.isGlobe).toBe(p.projType === 7)
  })

  it('worldBand === the earth-surface-fill 3-way split per projType', () => {
    // Table-side equivalence pin for the folded worldBandForProjType lookup:
    // {0,1,6}=mercator-clamped, {2}=natural-earth, {3,4,5,7}=sphere-full.
    // Mirrors the per-projType identity gate in earth-surface-fill.test.ts.
    const expected: Record<number, string> = {
      0: 'mercator-clamped',
      1: 'mercator-clamped',
      2: 'natural-earth',
      3: 'sphere-full',
      4: 'sphere-full',
      5: 'sphere-full',
      6: 'mercator-clamped',
      7: 'sphere-full',
    }
    for (const p of PROJECTIONS) {
      expect(p.worldBand).toBe(expected[p.projType])
    }
  })

  it('poleLimit() === Mercator limit for {0,1,6}, true pole (90) for {2,3,4,5,7}', () => {
    // Derived from the worldBand column: mercator-clamped → 85.051129°,
    // natural-earth + sphere-full → 90°. natural_earth (2) reaches the true
    // pole despite being cylindrical — it is NOT mercator-clamped.
    const expected: Record<number, number> = {
      0: 85.051129,
      1: 85.051129,
      6: 85.051129,
      2: 90,
      3: 90,
      4: 90,
      5: 90,
      7: 90,
    }
    for (const p of PROJECTIONS) {
      expect(poleLimit(p.projType)).toBe(expected[p.projType])
    }
  })

  it('poleLimit(0) === MERCATOR_LAT_LIMIT (drift gate vs projection.ts)', () => {
    // The table mirrors MERCATOR_LAT_LIMIT locally (MERCATOR_POLE_LIMIT) so the
    // authority file imports nothing; this gate pins the mirror equal to the
    // real const, mirroring projection-threshold-drift.test. Mutate either copy
    // → RED. Covers all three mercator-clamped projTypes for completeness.
    expect(poleLimit(0)).toBe(MERCATOR_LAT_LIMIT)
    expect(poleLimit(1)).toBe(MERCATOR_LAT_LIMIT)
    expect(poleLimit(6)).toBe(MERCATOR_LAT_LIMIT)
  })

  it("representsCenterAs() === 'mercator-y' for {0,1,2,6}, 'lat-deg' for {3,4,5,7}", () => {
    // Sphere-full family stores a true centre latitude; the cylindrical family
    // (incl. natural_earth, the DECIDED default) keeps Mercator-Y pan authority.
    const expected: Record<number, string> = {
      0: 'mercator-y',
      1: 'mercator-y',
      2: 'mercator-y',
      6: 'mercator-y',
      3: 'lat-deg',
      4: 'lat-deg',
      5: 'lat-deg',
      7: 'lat-deg',
    }
    for (const p of PROJECTIONS) {
      expect(representsCenterAs(p.projType)).toBe(expected[p.projType])
    }
  })

  it('cull/rim thresholds match shaders/projection.ts per projType', () => {
    // ortho(3) + globe(7) cull at the visibility boundary (0.0);
    // azimuthal(4) at -0.85; stereographic(5) at -0.8; flat/cylindrical
    // (0,1,2,6) have no hemisphere cull. US-002 ties these literals to the
    // WGSL source via projection-threshold-drift.test.ts.
    const expected: Record<number, number | null> = {
      0: null,
      1: null,
      2: null,
      3: 0.0,
      4: -0.85,
      5: -0.8,
      6: null,
      7: 0.0,
    }
    for (const p of PROJECTIONS) {
      expect(p.cullThreshold).toBe(expected[p.projType])
      expect(p.rimThreshold).toBe(expected[p.projType])
    }
  })
})

// ── T4: the #2093 F1 drape LOD ceiling ──
// bakesVectorDrape says WHICH SURFACE drapes; GLOBE_DIRECT_MIN_SELECTION_Z says
// HOW LONG it is worth draping. The bake→drape path trades BLUR (one 512px-bake
// texel — also the drape's whole AA feather band) for HUG (the chord sagitta the
// direct arm leaves under the sphere). Camera zoom CANCELS out of that ratio, so
// the crossover is a property of the TILE zoom alone — which is what makes a
// single selection-zoom integer a legitimate gate rather than a tuned constant.
describe('T4: GLOBE_DIRECT_MIN_SELECTION_Z — the #2093 drape LOD ceiling', () => {
  // One drape bake texture is BAKE_PX square (map/src/render/vector-drape-
  // renderer.ts:55 `const BAKE_PX = 512`). MIRRORED here, never imported: map
  // depends on geo, never the reverse. The mirror is pinned equal to its
  // authority by map/src/render/globe-direct-ceiling-selection.test.ts — the
  // mirror + drift-gate pattern MERCATOR_POLE_LIMIT already uses above.
  const BAKE_PX = 512

  /** Chord sagitta of a tile-wide edge at TILE zoom `z`, in CSS px at camera
   *  zoom `Z`: span·θ/8, where the tile spans `TILE_PX·2^(Z−z)` CSS px
   *  (world-scale.ts — the zoom↔pixel anchor) and subtends `2π·2^−z`. */
  const sagittaPx = (Z: number, z: number): number =>
    (TILE_PX * 2 ** (Z - z) * (2 * Math.PI * 2 ** -z)) / 8
  /** One bake texel of that same tile, in the same CSS px — its on-screen span
   *  spread over the BAKE_PX-wide bake. This is BOTH the drape's resolution
   *  floor AND its whole AA feather band (the bake runs at dpr=1). */
  const bakeTexelPx = (Z: number, z: number): number => (TILE_PX * 2 ** (Z - z)) / BAKE_PX

  it('=== the chord-sagitta crossover, mapped 1:1 onto currentZ', () => {
    // C/B = (BAKE_PX·π/4)·2^−z. `TILE_PX` CANCELS — it scales the tile's
    // on-screen span, which is the numerator of BOTH errors — so the crossover
    // is set by the BAKE resolution alone and the direct arm wins from TILE zoom
    // ceil(log2(BAKE_PX·π/4)) = 9 upward. (The BAKE_PX mirror above is pinned to
    // vector-drape-renderer.ts by the map-side gate; this file may not import it.)
    // `currentZ` is floor(cameraZoom) clamped to the source maxLevel, and the
    // globe selector force-descends the FOCAL tile to selMaxZ = currentZ
    // (globe-visible-tiles.ts:434), so the tiles under the camera centre are
    // drawn AT currentZ — the threshold maps 1:1, no off-by-one.
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(Math.ceil(Math.log2((BAKE_PX * Math.PI) / 4)))
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(9)
  })

  it('covers the #2093 report cameras (their selection zooms both go direct)', () => {
    // This file owns the PREDICATE half only. The CAMERA → currentZ half — that
    // zoom 9.70 on a maxLevel-14 source really resolves to 9, and 21.10 to 14 —
    // is driven through the production `TileSelectionCache.selectForFrame` in
    // map/src/render/globe-direct-ceiling-selection.test.ts. Reimplementing
    // `min(floor(cameraZoom), maxLevel)` here would be a SECOND AUTHORITY for a
    // derivation geo cannot reach (map → geo, never the reverse), green by
    // construction whatever the engine actually computes.
    expect(drapesAtSelectionZ(9), '#2093 native-zoom camera: zoom 9.70 → currentZ 9').toBe(false)
    expect(
      drapesAtSelectionZ(14),
      '#2093 deep-overzoom camera: zoom 21.10 on a maxLevel-14 source → currentZ 14',
    ).toBe(false)
    expect(
      drapesAtSelectionZ(2),
      'currentZ 2 — the globe overview, and equally zoom 9.70 on a maxzoom-2 source — keeps ' +
        'the great-circle drape and its #2024 windowed overzoom',
    ).toBe(true)
  })

  it('the blur-vs-sagitta verdict is INDEPENDENT of camera zoom (Z cancels)', () => {
    // Two claims, in premise → conclusion order (§12: assert the CAUSE before the
    // EFFECT, so a red run names the half that broke).
    //
    //   1. Z-INDEPENDENCE. The whole justification for gating on the SELECTION
    //      zoom is that the camera zoom drops out of C/B. Every Z must reproduce
    //      the verdict computed at the reference Z.
    //   2. THE CONSTANT. The analytic sagitta-vs-texel comparison is the ORACLE;
    //      `drapesAtSelectionZ` — i.e. GLOBE_DIRECT_MIN_SELECTION_Z — is the thing
    //      under test. A wrong ceiling reddens this sweep, which is what makes it
    //      a gate rather than a restatement of JavaScript's Math.
    const REF_Z = 0
    for (const Z of [2, 9.7, 15.3, 21.1]) {
      for (let z = 2; z <= 14; z++) {
        const C = sagittaPx(Z, z)
        const B = bakeTexelPx(Z, z)
        expect(
          C >= B,
          `Z=${Z} z=${z}: sagitta ${C}px vs bake texel ${B}px. FAILURE HERE MEANS the ` +
            `drape-vs-direct verdict moved with the CAMERA zoom. C/B must reduce to ` +
            `(BAKE_PX·π/4)·2^−z — a function of the TILE zoom alone — or gating the drape ` +
            `on a single selection-zoom integer is not legitimate at all.`,
        ).toBe(sagittaPx(REF_Z, z) >= bakeTexelPx(REF_Z, z))
        expect(
          drapesAtSelectionZ(z),
          `z=${z} (measured at Z=${Z}): sagitta ${C}px vs bake texel ${B}px. FAILURE HERE ` +
            `MEANS GLOBE_DIRECT_MIN_SELECTION_Z (${GLOBE_DIRECT_MIN_SELECTION_Z}) is not the ` +
            `crossover its derivation claims — the drape is kept where its bake texel is ` +
            `already wider than the chord it removes, or dropped where the chord still wins.`,
        ).toBe(C >= B)
      }
    }
  })

  it('drapesAtSelectionZ() switches exactly at the ceiling (8 drapes, 9 goes direct)', () => {
    expect(drapesAtSelectionZ(8), 'below the ceiling the great-circle hug is worth its blur').toBe(
      true,
    )
    expect(
      drapesAtSelectionZ(GLOBE_DIRECT_MIN_SELECTION_Z),
      'at the ceiling the 512px bake is blurrier than the chord it removes — render direct',
    ).toBe(false)
  })
})

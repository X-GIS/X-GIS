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
  GLOBE_DIRECT_MIN_STROKE_Z,
  drapesStrokesAtSelectionZ,
} from './projections-table'
import { MERCATOR_LAT_LIMIT } from './projection'

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
// ═══ T4 MOVED — the fill drape's WHEN is no longer geo's (#2094) ═══
//
// This block pinned `GLOBE_DIRECT_MIN_SELECTION_Z`, a LOD CEILING, plus the
// perspective-displacement and arc-curvature budgets it was derived from. The
// ceiling is retired: it could not express the question the two paths differ on,
// and the symptom was that every low zoom on a deep source kept the bake — the
// owner saw the z0-z5 blur on WebGPU while WebGL2, which never bakes, looked
// right, improving only on zoom-in past z6.
//
// Its replacement prices both paths in PIXELS and needs the tiler's subdivision
// rule, which geo may not import (geo depends on @xgis/shared only), so both the
// predicate and its pins moved to the consumer:
//
//     map/src/render/globe-drape-budget.ts       — GLOBE_DRAPE_CHORD_BUDGET_PX,
//                                                  directChordErrorPx, drapesAtChordBudget
//     map/src/render/globe-drape-budget.test.ts  — every native zoom direct, the
//                                                  two cameras measured direct-better,
//                                                  the shallow sources that must drape,
//                                                  the closed form, the #2435 peak
//     compiler/src/tiler/subdivision-conformance.test.ts
//                                                — `tileSegmentAngleRad` against what
//                                                  the real subdivision leaves
//
// That set is strictly larger than what T4 asserted, which is why this is a move
// and not a deletion. What geo still owns is WHICH SURFACE drapes
// (`bakesVectorDrape`, T3 above) and the STROKE half below.

describe('T5: GLOBE_DIRECT_MIN_STROKE_Z — the stroke half of the drape decision', () => {
  it('strokes never drape on the sphere route — at any selection zoom', () => {
    for (const z of [0, 1, 2, 5, 6, 9, 14, 22]) {
      expect(
        drapesStrokesAtSelectionZ(z),
        `selection zoom ${z}: a baked stroke is resampled onto the sphere grid, which no bake ` +
          `density removes — the "roads are still thick" report. Strokes go direct.`,
      ).toBe(false)
    }
  })

  it('is a SEPARATE decision from the fill gate, not the same one read twice', () => {
    // The whole point of INC-3: the two move independently. They now differ in
    // SHAPE as well as value — the fill gate is a per-camera pixel budget in
    // map/src/render/globe-drape-budget.ts, this one is a constant, because no
    // amount of over-zoom makes the bake the better tool for a curve. A refactor
    // that re-points one at the other silently re-couples them.
    expect(GLOBE_DIRECT_MIN_STROKE_Z).toBe(0)
    expect(drapesStrokesAtSelectionZ(0)).toBe(false)
  })
})

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
  GLOBE_DIRECT_MIN_STROKE_Z,
  drapesStrokesAtSelectionZ,
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
// texel, magnified on screen — also the drape's whole AA feather band) for the
// direct arm's CHORD error, which lives only on tile-spanning straight edges and
// improves 4× per zoom level. The ceiling is the reference-engine parity point
// (projections-table.ts derives it): the zoom from which MapLibre's globe needs no
// more than a 2×2 subdivision to draw the same tiles direct.
describe('T4: GLOBE_DIRECT_MIN_SELECTION_Z — the #2093 drape LOD ceiling', () => {
  /** MapLibre's globe subdivides fill geometry at granularity
   *  max(1, BASE / 2^z) — subdivision.ts's `SubdivisionGranularityExpression(128, 1)`
   *  for fills. The reference engine's own constant, mirrored here as the parity
   *  oracle the ceiling is derived from. */
  const MAPLIBRE_FILL_BASE_GRANULARITY = 128
  /** Reference viewport width (CSS px) the error budgets are quoted for. */
  const VIEWPORT_PX = 1024
  /** Camera height above the surface in earth radii at zoom Z, for a 60° fov
   *  over VIEWPORT_PX: h/R = 0.866·W·(2π/(TILE_PX·2^Z)). */
  const cameraHeightR = (Z: number): number =>
    (0.866 * VIEWPORT_PX * 2 * Math.PI) / (TILE_PX * 2 ** Z)
  /** PERSPECTIVE DISPLACEMENT of a chord spanning a whole tile of zoom z at camera
   *  zoom Z: ε = D²/(2·R·h) with D/R = 2π·2^−z — the fraction of its screen
   *  offset an edge is pulled toward the frame centre. */
  const perspectiveEps = (Z: number, z: number): number =>
    (2 * Math.PI * 2 ** -z) ** 2 / (2 * cameraHeightR(Z))
  /** ARC CURVATURE inside the viewport at pitch 0: the projected sagitta of a
   *  great-circle arc of on-screen length W passing at the viewport's own
   *  angular half-width from the nadir, W³/(16·R_px²), R_px = TILE_PX·2^Z/(2π). */
  const arcSagittaPx = (Z: number): number => {
    const rPx = (TILE_PX * 2 ** Z) / (2 * Math.PI)
    return VIEWPORT_PX ** 3 / (16 * rPx * rPx)
  }

  it('=== the ceiling is the MapLibre 2×2-subdivision parity point', () => {
    // The reference engine subdivides a tile of zoom z into max(1, 128/2^z) cells
    // per axis and draws it direct; from the zoom where that is ≤ 2 it is
    // drawing the same tiles with at most a 2×2 split, and above ~z6 it blends to
    // a flat Mercator plane altogether. Direct-from-six is that parity point.
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(
      Math.ceil(Math.log2(MAPLIBRE_FILL_BASE_GRANULARITY / 2)),
    )
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(6)
  })

  it('the chord budget at the ceiling is what the derivation quotes, and shrinks 4× per level', () => {
    // Native zoom (Z = z): the two error terms of a tile-spanning straight edge.
    // These are the numbers projections-table.ts commits to; a drift in either
    // formula — or in TILE_PX — reddens here with the new value in the message.
    const z = GLOBE_DIRECT_MIN_SELECTION_Z
    const eps = perspectiveEps(z, z)
    const arc = arcSagittaPx(z)
    expect(
      eps,
      `perspective displacement at native z${z}: ${(eps * 100).toFixed(2)} %`,
    ).toBeCloseTo(1.81 * 2 ** -z, 2)
    expect(eps * (VIEWPORT_PX / 2), 'px at the frame edge').toBeLessThan(15)
    expect(arc, `arc sagitta at Z=${z}: ${arc.toFixed(2)} px`).toBeCloseTo(10106 * 4 ** -z, 1)
    expect(arc).toBeLessThan(2.6)
    for (let k = z; k < 14; k++) {
      expect(
        perspectiveEps(k + 1, k + 1) / perspectiveEps(k, k),
        'ε halves per level at native zoom',
      ).toBeCloseTo(0.5, 6)
      expect(arcSagittaPx(k + 1) / arcSagittaPx(k), 'the arc term quarters per level').toBeCloseTo(
        0.25,
        6,
      )
    }
    // One level BELOW the ceiling the same edge is already twice as far off and
    // the whole-hemisphere arcs curve visibly — the drape's hug is worth its blur.
    expect(perspectiveEps(z - 1, z - 1) * (VIEWPORT_PX / 2)).toBeGreaterThan(25)
    expect(arcSagittaPx(z - 1)).toBeGreaterThan(9)
  })

  it('over-zooming a shallow source multiplies the chord error — the source clamp is load-bearing', () => {
    // ε = 1.81·2^(Z−2z): drawing z2 tiles at camera z10 (the maxzoom-2 demotiles
    // mirror at _globe-drape-overzoom-gate's camera) puts a tile-spanning edge
    // hundreds of percent off — the gate must read the DRAWN zoom, never the
    // camera's, and such a source keeps the drape at every camera zoom.
    expect(perspectiveEps(10, 2)).toBeGreaterThan(1)
    expect(drapesAtSelectionZ(2), 'currentZ clamps to 2 on that source').toBe(true)
    // MapLibre's own demotiles (maxzoom 6) reaches the ceiling exactly.
    expect(drapesAtSelectionZ(6), 'a maxzoom-6 source at any camera zoom ≥ 6 renders direct').toBe(
      false,
    )
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

  it('drapesAtSelectionZ() switches exactly at the ceiling (5 drapes, 6 goes direct)', () => {
    expect(drapesAtSelectionZ(5), 'below the ceiling the great-circle hug is worth its blur').toBe(
      true,
    )
    expect(
      drapesAtSelectionZ(GLOBE_DIRECT_MIN_SELECTION_Z),
      'at the ceiling the direct arm is the sharper, better-placed frame — render direct',
    ).toBe(false)
  })
})

// ═══ design INC-3 — strokes have their OWN ceiling, and it is not the fill's ═══
//
// Fills and strokes shared one decision because they share one bake texture. Their
// error budgets do not have the same shape: a fill is an AREA (a mis-subdivided
// shared border between two LODs leaves a hairline crack, and the globe renders
// mixed LOD every frame), a stroke is a CURVE (no neighbour, no gap — and
// `subdivideChainMM` densifies it with the same 2°/depth-5 rule the fill triangles
// get). What the drape costs a stroke is unconditional: a resample onto the sphere
// grid, ~1 px of filter on every road at every zoom.
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

  it('is a SEPARATE constant from the fill ceiling, not the same one read twice', () => {
    // The whole point of INC-3: the two can move independently. A refactor that
    // re-points one at the other silently re-couples them.
    expect(GLOBE_DIRECT_MIN_STROKE_Z).not.toBe(GLOBE_DIRECT_MIN_SELECTION_Z)
    expect(GLOBE_DIRECT_MIN_STROKE_Z).toBe(0)
  })

  it('the FILL ceiling is unmoved — the cross-LOD skirt still gates it', () => {
    // Strokes going direct says nothing about fills: the crack a fill can leave
    // between two LODs is an area defect with no stroke analogue, and the skirt
    // that closes it is unbuilt (design correction #4).
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(6)
    expect(drapesAtSelectionZ(5), 'fills below the ceiling still drape').toBe(true)
  })
})

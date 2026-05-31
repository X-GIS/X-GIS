// ═══ PROJECTIONS — single source of truth for projType → behavior ═══
//
// The projType↔name↔capability relationship was previously hand-encoded
// across ~3 representations (the render-loop name→int map, VTR's
// SELECTOR_PROJ_NAMES int→name array, and inline name→int collapses in
// tiles-sse / tile-select). This ordered record array — index == projType
// == the `proj_params.x` wire value the shaders read — is the canonical
// data those representations derive from.
//
// Scope note (H1a): this commit wires only the CANONICAL name↔int sites
// (render-loop map + SELECTOR_PROJ_NAMES) to this table. The lossy
// capability collapses (tiles-sse `?0:2:1`, tile-select `?0:1`) are
// behavior-coupled — feeding them the real projType changes non-mercator
// world-copy enumeration — so they migrate later under EffectiveProjection
// (H1b), not here. THIS TABLE IS THE SINGLE SOURCE OF TRUTH (authority flip,
// P1): the world-copy / sphere-routing predicates (worldCopiesFor /
// enumerateWorldCopies / routeToSphereSelector) now DERIVE from these rows
// and are defined in this file; gpu-shared.ts re-exports them so its
// consumers are unchanged. `projections-table.test.ts` pins each field to
// its intended literal value, and `projection-threshold-drift.test.ts` pins
// the emitted WGSL thresholds to `cullThreshold`, so neither can drift.

// World-copy offsets: primary + N copies each side, for the periodic
// (cylindrical / pseudocylindrical) family. Other projections collapse to a
// single world. Defined HERE (was gpu-shared) so the table imports nothing
// from gpu-shared — gpu-shared re-exports these, inverting the dependency.
export const WORLD_COPIES = [-2, -1, 0, 1, 2]
// Single-world copy set for the non-periodic (hemispherical / globe)
// projections. `[0]` is irreducible.
const SINGLE_WORLD: readonly number[] = [0]
/** Max zoom at which periodic projections still enumerate neighbour world
 *  copies (above this the neighbours are off-canvas). */
export const WORLD_COPY_MAX_ZOOM = 4

export interface ProjectionRecord {
  /** Registry name — matches `Projection.name` and the style
   *  `projectionName`. */
  readonly name: string
  /** Integer projType == array index == shader `proj_params.x`. */
  readonly projType: number
  /** `needs_backface_cull` cos_c threshold (shaders/projection.ts).
   *  `null` for projections with no hemisphere cull (flat 0/1/2,
   *  cylindrical-on-sphere oblique 6). ortho/globe cull at the visibility
   *  boundary (0.0); azimuthal at -0.85; stereographic at -0.8. */
  readonly cullThreshold: number | null
  /** `rim_alpha` smoothstep lower bound — identical to cullThreshold for
   *  the culling projections; `null` where there is no rim. */
  readonly rimThreshold: number | null
  /** WGSL `needs_backface_cull` "flat projections — no culling" branch
   *  (t<2.5): mercator / equirect / natural_earth. */
  readonly isFlat: boolean
  /** Has a longitude seam at the antimeridian (anchor-geometry-parity
   *  SEAM_PROJ): equirect / natural_earth / oblique_mercator. */
  readonly isSeam: boolean
  /** Cylindrical / pseudocylindrical — 2π-periodic in longitude, emits
   *  multiple world copies (== worldCopiesFor multi-world set:
   *  mercator / equirect / natural_earth / oblique_mercator). */
  readonly isCylindrical: boolean
  /** The true 3D sphere path (projType 7). */
  readonly isGlobe: boolean
  /** Routed through the zoom-gated globe world-copy enumeration
   *  (enumerateWorldCopies periodic set: equirect / natural_earth /
   *  oblique_mercator). Excludes mercator, which is flat-selector-routed. */
  readonly periodic: boolean
  /** World-copy offsets (worldCopiesFor): WORLD_COPIES for the cylindrical
   *  family, SINGLE_WORLD otherwise. */
  readonly worldCopies: readonly number[]
}

export const PROJECTIONS: readonly ProjectionRecord[] = [
  { name: 'mercator',              projType: 0, cullThreshold: null,  rimThreshold: null,  isFlat: true,  isSeam: false, isCylindrical: true,  isGlobe: false, periodic: false, worldCopies: WORLD_COPIES },
  { name: 'equirectangular',       projType: 1, cullThreshold: null,  rimThreshold: null,  isFlat: true,  isSeam: true,  isCylindrical: true,  isGlobe: false, periodic: true,  worldCopies: WORLD_COPIES },
  { name: 'natural_earth',         projType: 2, cullThreshold: null,  rimThreshold: null,  isFlat: true,  isSeam: true,  isCylindrical: true,  isGlobe: false, periodic: true,  worldCopies: WORLD_COPIES },
  { name: 'orthographic',          projType: 3, cullThreshold: 0.0,   rimThreshold: 0.0,   isFlat: false, isSeam: false, isCylindrical: false, isGlobe: false, periodic: false, worldCopies: SINGLE_WORLD },
  { name: 'azimuthal_equidistant', projType: 4, cullThreshold: -0.85, rimThreshold: -0.85, isFlat: false, isSeam: false, isCylindrical: false, isGlobe: false, periodic: false, worldCopies: SINGLE_WORLD },
  { name: 'stereographic',         projType: 5, cullThreshold: -0.8,  rimThreshold: -0.8,  isFlat: false, isSeam: false, isCylindrical: false, isGlobe: false, periodic: false, worldCopies: SINGLE_WORLD },
  { name: 'oblique_mercator',      projType: 6, cullThreshold: null,  rimThreshold: null,  isFlat: false, isSeam: true,  isCylindrical: true,  isGlobe: false, periodic: true,  worldCopies: WORLD_COPIES },
  { name: 'globe',                 projType: 7, cullThreshold: 0.0,   rimThreshold: 0.0,   isFlat: false, isSeam: false, isCylindrical: false, isGlobe: true,  periodic: false, worldCopies: SINGLE_WORLD },
]

// ═══ Derived predicates (the authority flip) ═══════════════════════════
// These read the rows above. gpu-shared.ts re-exports them so its consumers
// (tiles-sse, tile-select, vector-tile-renderer, camera, label-pass) are
// unchanged. Behaviour is pinned by world-copy-gap.test.ts,
// antimeridian-routing.test.ts, and tile-selection-projection.test.ts.

/** World-copy offsets for a projType: the periodic family emits ±2 copies,
 *  everything else collapses to a single world. (Was the literal
 *  `===0||1||2||6` set in gpu-shared; now a pure table lookup.) */
export function worldCopiesFor(projType: number): readonly number[] {
  return PROJECTIONS[projType]?.worldCopies ?? SINGLE_WORLD
}

/** Whether the periodic projections (equirect / natural_earth /
 *  oblique_mercator) should enumerate neighbour world copies at this zoom.
 *  Mercator is flat-selector-routed and excluded (periodic=false). Above
 *  WORLD_COPY_MAX_ZOOM the neighbours are off-canvas. */
export function enumerateWorldCopies(projType: number, zoom: number): boolean {
  return (PROJECTIONS[projType]?.periodic ?? false) && zoom <= WORLD_COPY_MAX_ZOOM
}

/** Whether tile selection routes through the sphere-aware globeVisibleTiles
 *  selector instead of the flat frustum selectors. The azimuthal family
 *  (3/4/5) and oblique_mercator (6) project relative to the camera centre,
 *  so the flat selector hands them the wrong tile set once panned; globe (7)
 *  reaches this via `globeMode`. Derived: `!isFlat && !isGlobe` is exactly
 *  {3,4,5,6} (0/1/2 are flat-routed; 7 routes via the globeMode flag). */
export function routeToSphereSelector(projType: number, globeMode: boolean): boolean {
  const r = PROJECTIONS[projType]
  return globeMode || (r ? !r.isFlat && !r.isGlobe : false)
}

/** Whether a projection PROMOTES to the 3D globe path when the camera tilts
 *  (pitch > 0). The azimuthal family (ortho 3 / azimuthal_eq 4 /
 *  stereographic 5) are exact 2D discs at pitch=0 but become true spheres
 *  once tilted, so render-loop promotes them to projType 7 + globeMode.
 *  Derived `!isFlat && !isGlobe && !isCylindrical` = exactly {3,4,5}.
 *
 *  NOTE (latent gap, oblique-6-promotion.test.ts): oblique_mercator (6)
 *  sphere-ROUTES its tiles (routeToSphereSelector → true) yet is EXCLUDED
 *  here (it is cylindrical), so at pitch>0 it keeps the flat MVP while its
 *  tiles come from the sphere selector — flat MVP + sphere tiles. Fixing it
 *  (promote 6, or flat-route its tiles) is a behaviour change deferred to a
 *  GPU-verified effort; the difference between these two predicates IS the
 *  bug, made explicit by the table. */
export function promotesToGlobeWhenTilted(projType: number): boolean {
  const r = PROJECTIONS[projType]
  return r ? !r.isFlat && !r.isGlobe && !r.isCylindrical : false
}

// ── Capability accessor used by the flat-vs-ECEF MVP gate (camera /
//    label-pass / render-loop). Add siblings (isFlatProj / periodicOf /
//    cullThresholdOf …) here when a real consumer needs them — not before. ──
export const isGlobeProj = (projType: number): boolean => PROJECTIONS[projType]?.isGlobe ?? false

/** Canonical name → projType map. Derived from PROJECTIONS; replaces the
 *  hand-written object literal in render-loop. Unknown names fall back to
 *  mercator (0) at the call site, matching the prior `?? 0`. */
export const PROJECTION_NAME_TO_TYPE: Readonly<Record<string, number>> =
  Object.fromEntries(PROJECTIONS.map((p) => [p.name, p.projType]))

/** Int → name for the flat-projection selector (projType 0..6). Globe (7)
 *  has no flat-projection entry and is handled separately by callers. */
export const SELECTOR_PROJ_NAMES: readonly string[] =
  PROJECTIONS.filter((p) => !p.isGlobe).map((p) => p.name)

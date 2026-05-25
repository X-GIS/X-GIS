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
// (H1b), not here. The gpu-shared predicates (worldCopiesFor /
// enumerateWorldCopies / routeToSphereSelector) remain the AUTHORITY for
// the capability fields; `projections-table.test.ts` pins every field in
// this table to those predicates + the WGSL thresholds so the table can
// never drift from real behavior.

import { WORLD_COPIES } from '../gpu/gpu-shared'

// Single-world copy set for the non-periodic (hemispherical / globe)
// projections. `[0]` is irreducible; pinned === worldCopiesFor() output
// by the table test.
const SINGLE_WORLD: readonly number[] = [0]

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

/** Canonical name → projType map. Derived from PROJECTIONS; replaces the
 *  hand-written object literal in render-loop. Unknown names fall back to
 *  mercator (0) at the call site, matching the prior `?? 0`. */
export const PROJECTION_NAME_TO_TYPE: Readonly<Record<string, number>> =
  Object.fromEntries(PROJECTIONS.map((p) => [p.name, p.projType]))

/** Int → name for the flat-projection selector (projType 0..6). Globe (7)
 *  has no flat-projection entry and is handled separately by callers. */
export const SELECTOR_PROJ_NAMES: readonly string[] =
  PROJECTIONS.filter((p) => !p.isGlobe).map((p) => p.name)

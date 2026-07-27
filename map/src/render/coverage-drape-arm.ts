// ═══ When does a coverage draw its DRAPE, and in which mode? (#1333) ═══
//
// One decision, three cases, extracted from the two arm sites (the layer rebuild and the
// transient re-arm) so they cannot disagree — and so the cases are testable as arithmetic
// rather than pinned by a regex over `map.ts`.
//
// THE CASE THAT MOTIVATED THE EXTRACTION IS THE MIDDLE ONE. Motion used to be welded to the
// colour fill: the arm skipped the drape entirely whenever a field keyword appeared without a
// `ramp`. But the IHO S-111 Portrayal Catalogue defines static point symbols and nothing else
// — `<lineStyles/>`, `<areaFills/>` and `<pixmaps/>` are all empty — so a strictly conformant
// style declares NO ramp, and under the old rule it could therefore never show the motion at
// all. Wanting the animation meant also accepting a non-catalogue colour area, which is
// exactly backwards: the animation is the optional extra, not the colour scale.

/** The paint axes this decision reads. Structurally a `ShowCommand`, narrowed to what matters
 *  so the rule can be exercised without building one. */
export interface CoverageDrapeShow {
  isArrow?: boolean
  isFlow?: boolean
  ramp?: string
}

/** Whether the coverage drape draws, and whether it draws the advected field ALONE. */
export type CoverageDrapeArm =
  | { draw: false }
  | {
      draw: true
      /** Emit a neutral luminance modulation instead of the ramp colour — the catalogue
       *  arrows stay the only colour authority on screen. */
      flowOnly: boolean
    }

/**
 * 1. `| arrow` alone, no `ramp` → **no drape**. The strict catalogue portrayal: coloured
 *    symbols at grid points and nothing else. This is the only case that draws nothing.
 * 2. `| flow`, no `ramp` → **drape, flow-only**. The motion is visible without inventing a
 *    colour scale the catalogue does not define.
 * 3. anything with a `ramp`, or a bare coverage → **drape, ramped** (default viridis when
 *    unstated). Declaring a `ramp` is the explicit opt-in to the non-standard colour fill,
 *    and it composes under whatever field layers also run.
 */
export function coverageDrapeArm(show: CoverageDrapeShow): CoverageDrapeArm {
  if (show.ramp !== undefined) return { draw: true, flowOnly: false }
  if (show.isFlow === true) return { draw: true, flowOnly: true }
  if (show.isArrow === true) return { draw: false }
  return { draw: true, flowOnly: false }
}

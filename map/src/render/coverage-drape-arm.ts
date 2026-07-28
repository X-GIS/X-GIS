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
  /** Presence only — a layer whose portrayal is sounding NUMERALS (#1366 INC-5). Typed
   *  `unknown` because this rule needs to know THAT there are labels, never what they say. */
  label?: unknown
  /** Which motion portrayal a `| flow` layer asked for (#1418). Undefined resolves to `arrows`
   *  HERE rather than in the compiler, which is where the decision was recorded. */
  flowPortrayal?: 'arrows' | 'streaks'
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
 * 2. `| flow`, no `ramp` → depends on the PORTRAYAL (#1418/#1419): `streaks` → **drape,
 *    flow-only** (the motion is visible without inventing a colour scale the catalogue does not
 *    define); `arrows`, the default → **no drape**, because the moving catalogue glyphs ARE the
 *    motion layer.
 * 3. sounding numerals alone, no `ramp` → **no drape** (#1366 INC-5). Same shape as case 1,
 *    and load-bearing for the same reason the extraction was: a chart puts its numerals on a
 *    SECOND layer over the ramp layer, so ONE coverage source carries TWO shows and this arm
 *    runs for each. Without this case the numerals' show re-armed the drape with the DEFAULT
 *    viridis, silently repainting the `ramp: "bathymetry"` layer authored right above it —
 *    caught by a before/after render diff, not by any unit gate.
 * 4. anything with a `ramp`, or a bare coverage → **drape, ramped** (default viridis when
 *    unstated). Declaring a `ramp` is the explicit opt-in to the non-standard colour fill,
 *    and it composes under whatever field layers also run.
 */
export function coverageDrapeArm(show: CoverageDrapeShow): CoverageDrapeArm {
  if (show.ramp !== undefined) return { draw: true, flowOnly: false }
  if (show.isFlow === true) {
    // #1419 — the portrayal decides WHICH motion layer, and only one of them may draw. Under
    // `arrows` (the default) the catalogue glyphs themselves are the particles, so a flow-only
    // drape has nothing left to contribute: it would put a second, independently-advected
    // motion layer under arrows that are already moving, and the two disagree visibly about the
    // same current. `streaks` keeps the IBFV drape, unchanged.
    return show.flowPortrayal === 'streaks' ? { draw: true, flowOnly: true } : { draw: false }
  }
  if (show.isArrow === true) return { draw: false }
  if (show.label !== undefined) return { draw: false }
  return { draw: true, flowOnly: false }
}

// ═══ Arming ONE coverage region — drape + arrow (#1333, extracted by #1426) ═══
//
// What a `coverage` layer actually DRAWS for one resident region, in one place. Three call
// sites answer to it and none of them may disagree: the layer rebuild, the transient re-arm
// (an interpolated playback frame), and the deferred declared-source load — whose cell lands
// long after the rebuild already ran with the source resident but empty.
//
// Extracted from map.ts (shrink-only) once the third site appeared: three copies of
// "drape, then arrows, clearing THIS region's glyphs first" is exactly the drift the
// `coverageDrapeArm` decision was extracted to prevent one layer down.

import type { CoverageHandle } from '@xgis/data'
import { addCoverageArrowShowLayer, type CoverageArrowShowHost } from './coverage-arrow-show'
import { coverageDrapeArm } from './render/coverage-drape-arm'
import type { CoverageRenderer } from './render/coverage-renderer'
import type { ShowCommand } from './render/renderer-types'

/** The slice of XGISMap an arm touches. */
export interface CoverageArmHost extends CoverageArrowShowHost {
  readonly coverageRenderer: CoverageRenderer
}

/** Arm the coverage DRAPE for a show — the single authority every arm site answers to, so
 *  they cannot disagree about when the fill draws.
 *
 *  THREE CASES, and the middle one is the point (#1333):
 *
 *  1. No field keyword           → the fill draws as always (default viridis).
 *  2. `| flow`, no `ramp`        → FLOW-ONLY. The drape draws, but as a neutral luminance
 *                                  modulation with no colour ramp: the motion is visible
 *                                  while the CATALOGUE ARROWS remain the only colour
 *                                  authority. Before this, motion was welded to the
 *                                  non-standard fill, so a strictly-conformant style
 *                                  (arrows, no ramp) could not have it at all.
 *  3. `| arrow` alone, no `ramp` → the STRICT catalogue portrayal: arrows, no drape.
 *
 *  Declaring a `ramp` always adds the non-standard colour fill under whatever else runs. */
export function armCoverageDrape(
  host: CoverageArmHost,
  show: ShowCommand,
  handle: CoverageHandle,
  region: string,
): void {
  const arm = coverageDrapeArm(show)
  if (!arm.draw) return
  host.coverageRenderer.setCoverage(
    handle,
    {
      ramp: show.ramp ?? 'viridis',
      rangeLo: show.range?.[0],
      rangeHi: show.range?.[1],
      opacity: show.opacity ?? 1,
      flowOnly: arm.flowOnly,
    },
    region,
  )
}

/** Arm ONE region for ONE show, REPLACING whatever that region held — drape + arrow, the
 *  whole of what a coverage layer draws. The re-arm entry point (a data swap, a forecast
 *  step, an interpolated playback frame). */
export function armCoverageShow(
  host: CoverageArmHost,
  show: ShowCommand,
  handle: CoverageHandle,
  region: string,
): void {
  armCoverageDrape(host, show, handle, region)
  if (!show.isArrow) return
  // Clear THIS region's arrows only. Clearing all of them here is what kept the mosaic
  // single-region even after the renderer could hold several: a neighbour's time step
  // wiped every other domain's glyphs and re-added just its own.
  host.graphics.clearCompiledArrows(region)
  addCoverageArrowShowLayer(host, show, handle, region)
}

/** Arm a region whose cell has just landed from the DEFERRED declared-source read (#1426),
 *  reading the paint off the source's OWN ShowCommand(s) rather than the renderer's live
 *  display opts: a FIRST arm has no live paint to carry over, only renderer defaults, so a
 *  fill-only coverage would silently lose the `ramp:` / `range:` its layer declared.
 *
 *  EVERY matching show, not the first — one coverage source legitimately carries two layers
 *  (a ramp layer with sounding numerals over it, #1366 INC-5), and the rebuild walks them the
 *  same way. Hence the clear is hoisted OUT of the loop rather than reusing `armCoverageShow`
 *  per show: a per-show clear would have the second show wipe the first one's glyphs. */
export function armLandedCoverage(
  host: CoverageArmHost,
  shows: readonly ShowCommand[],
  sourceId: string,
  handle: CoverageHandle,
  region: string,
): void {
  host.graphics.clearCompiledArrows(region)
  for (const show of shows) {
    if (show.targetName !== sourceId) continue
    armCoverageDrape(host, show, handle, region)
    if (show.isArrow) addCoverageArrowShowLayer(host, show, handle, region)
  }
}

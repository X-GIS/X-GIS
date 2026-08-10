// ═══ Telling the author why a data-driven fill vanished on WebGL2 (#1583) ═══
//
// `fill match(…)` / `fill gradient(…)` compute their colour inside a shader variant. The WebGL2/RHI
// backend compiles none — `pipeline-factory.ts` returns before building any variant pipeline there,
// `POLYGON_FILL_FORMAT` carries no colour attribute, and the palette atlas is never uploaded — so
// `renderFillsRhi` finds a null CPU-resolved colour and returns without drawing. The layer
// disappears. Shipped styles hit this (continent-match, income-match, gdp-gradient,
// population-gradient, coops-currents).
//
// THE BLANK STAYS. There is no colour on that backend to draw with, so drawing anyway would emit a
// fully transparent quad — pixel-identical, one wasted draw call. Painting a representative flat
// colour instead would be worse than blank: on a choropleth a single colour misreports the data,
// the same class of error the S-111 arrow work exists to avoid. The capability itself is #1592.
// What lives here is the other half: the blank stops being SILENT.
//
// ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────────────────────────
//
// Not filing convenience. The two obvious hosts both forbid it in their own headers —
// `renderer-helpers.ts` is "no module mutable state, no side effects" and `feature-helpers.ts` is
// "pure functions … no engine state" — and this is a latched, IO-performing diagnostic that is
// neither. Inlining it in `vector-tile-renderer.ts` was the other option, and that file is a
// god-file sitting exactly on its shrink-only LOC ceiling.
//
// The reason that matters beyond bookkeeping: `renderFillsRhi` needs a live RHI device and a
// camera-driven tile selection before it reaches the bail, so a test could only ever restate the
// predicate alongside it. That is precisely the shape of `polygon-skip-fill-draw.test.ts`, which
// mirrors the WebGPU predicate, never calls the renderer, and stayed green for this bug's entire
// life while the RHI path violated the very assertion it makes. Here the guard, the message and
// the latch are one directly testable unit.

import { xlog } from '@xgis/shared'
import { variantProducesFill } from './renderer-helpers'
import type { ShowCommand } from './renderer-types'

/** Layer names already reported.
 *
 *  MODULE-SCOPE, and deliberately holding STRINGS ONLY. A per-renderer Set would be tidier in
 *  principle, but the renderer is on its LOC ceiling and cannot take the field, and the usual
 *  objection to module state (it outlives a destroyed map — #1567) is about RETENTION: nothing
 *  here references a map, a renderer or a GPU resource, so a destroyed map is not pinned. The
 *  real cost is the honest one: after a map is torn down and rebuilt, a layer already reported in
 *  this page's lifetime stays quiet. For a develop-time diagnostic that is the right trade — the
 *  message has already been delivered, and repeating it on every scene swap is how a diagnostic
 *  becomes noise. */
const reported = new Set<string>()

/** Report that this layer's data-driven fill cannot draw on this backend, at most once per layer.
 *
 *  Returns 0 — the draw count the caller reports for a fill it did not draw — so the bail stays a
 *  single statement in a file that has no room for more.
 *
 *  A null CPU fill colour means two different things and only one is a problem. For a line-only
 *  layer it is the correct answer: no fill was asked for, none is drawn, and this must stay quiet.
 *  For a data-driven fill it means the colour lives in a variant this backend will never compile.
 *  `variantProducesFill` is what separates them, and it is load-bearing in the NOISY direction —
 *  without it every `| line` layer in every style would warn, and a message that common is one
 *  nobody reads.
 *
 *  Latched because the caller runs per show per frame: unlatched, this would emit tens of times a
 *  second and scroll itself away, which for the author it is written for is the same as silence.
 *  Keyed per layer, not globally — a style with three data-driven layers has three problems, and
 *  reporting only the first would understate it. */
export function reportRhiFillGap(show: ShowCommand, backend: string): 0 {
  if (!variantProducesFill(show.shaderVariant)) return 0
  const layer = show.layerName ?? show.targetName
  if (reported.has(layer)) return 0
  reported.add(layer)
  xlog.warn(
    `[VectorTileRenderer] layer "${layer}": a data-driven fill draws nothing on the ${backend} ` +
      `backend — this backend has no per-feature GPU fill path (#1592). The layer is not broken; ` +
      `its colour is computed in a shader variant that only the WebGPU backend compiles. ` +
      `Use a constant \`fill\` here, or run on WebGPU.`,
  )
  return 0
}

/** Drop the latch — tests only, so one case's warning cannot silence the next one's. */
export function resetRhiFillGapReports(): void {
  reported.clear()
}

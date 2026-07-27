// ═══ Coverage sounding dispatch — the label pass's coverage arm (#1366 INC-5) ═══
//
// A coverage source holds a GRID, not features, so it matched neither of the label pass's
// two dispatch paths (`features` in rawDatasets, or a vector-tile entry). `| label-[…]` on
// a coverage layer therefore compiled cleanly and drew NOTHING, silently. This is the
// missing arm: it turns selected grid cells into `addLabel` calls, so soundings ride the
// SAME text authority as every other label and inherit collision, fade, zoom gating and
// the dispatch-skip cache rather than growing a second text path.
//
// Extracted from label-pass.ts rather than inlined there (the LOC ratchet's "extract,
// don't grow"), mirroring `place-labels-along-line.ts` — same shape: the pass hands in its
// per-frame closures, this owns the walk.

import type { LabelDef } from '@xgis/compiler'
import type { CoverageHandle } from '@xgis/data'
import { coverageSoundingAnchors, SOUNDING_LATTICE_CSS_PX } from '../../coverage-sounding-anchors'

/** `TextStage.addLabel`, narrowed to the arguments this arm passes. */
type AddLabel = (
  value: LabelDef['text'],
  props: Record<string, unknown>,
  x: number,
  y: number,
  def: LabelDef,
  fontKey: string | undefined,
  layerName: string,
  pairKey: string | undefined,
  collisionId: string | undefined,
  perspectiveScale: number | undefined,
) => void

/** Emit one label per selected cell of `handle`.
 *
 *  The label's property bag is the cell's bands keyed by NAME, so `label-[round(.depth)]`
 *  reads a band exactly the way it would read a feature property — no coverage-specific
 *  authoring vocabulary. Values come from the ORIGINAL grid (`valueAt`, nearest-cell), so
 *  a numeral can only ever print a depth the cell actually holds. */
export function dispatchCoverageSoundings(
  handle: CoverageHandle,
  unproject: (px: number, py: number) => [number, number] | null,
  viewport: { width: number; height: number; dpr: number },
  applyFeatureExprs: (props: Record<string, unknown>) => LabelDef,
  projectLonLatCopies: (lon: number, lat: number) => Array<[number, number, number]>,
  addLabel: AddLabel,
  layerName: string,
  /** The coverage REGION these cells belong to (#1272 E-④). Used only to namespace the
   *  collision id: a mosaic's regions have independent (col,row) grids, so without it two
   *  domains would share a cell identity and fade each other out. The LAYER name is
   *  deliberately NOT namespaced — that is the collision pass's precedence bucket. */
  region: string,
): void {
  const anchors = coverageSoundingAnchors(handle, unproject, {
    width: viewport.width,
    height: viewport.height,
    spacingPx: SOUNDING_LATTICE_CSS_PX * viewport.dpr,
  })
  for (const a of anchors) {
    const def = applyFeatureExprs(a.values)
    for (const projected of projectLonLatCopies(a.lon, a.lat)) {
      addLabel(
        def.text,
        a.values,
        projected[0],
        projected[1],
        def,
        undefined,
        layerName,
        undefined,
        // CELL identity, not anchor position: the screen anchor moves every frame while
        // the cell does not, so a numeral fades across camera moves instead of popping.
        `${layerName}:${region}:${a.col},${a.rowFromSouth}`,
        projected[2],
      )
    }
  }
}

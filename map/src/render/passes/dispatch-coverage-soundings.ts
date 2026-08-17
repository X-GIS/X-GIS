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
import { filterAcceptsProps } from '../../feature-helpers'
import { coverageCellPredicate } from '../../shaders/dsl/coverage-filter-cpu'
import { unprojectGlobeFromCamera, type Camera } from '../../camera'

/** The probe `visibleCellRange` (coverage-sounding-anchors.ts) walks to find which cells are
 *  on screen. `Camera.unprojectToLonLat` describes the flat Mercator plane only — it returns
 *  null unconditionally in globe mode (incl. tilted azimuthal, promoted to projType 7 by the
 *  render loop), so every probe missed and the walk always returned []. Same fork the pointer
 *  path already takes (`interaction-controller.ts` `clientToLngLat`): globe mode inverts
 *  through the real ray↔sphere authority instead of the phantom flat plane. */
export function soundingUnprojector(
  cam: Camera,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): (px: number, py: number) => [number, number] | null {
  return (px, py) =>
    cam.globeMode
      ? unprojectGlobeFromCamera(cam, px, py, canvasWidth, canvasHeight, dpr)
      : cam.unprojectToLonLat(px, py, canvasWidth, canvasHeight, dpr)
}

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

/** The per-show settings this arm needs, bundled rather than trailing the closure arguments —
 *  the parameter list was already at the point where a caller counts commas to place one. */
export interface SoundingDispatchOptions {
  layerName: string
  /** The coverage REGION these cells belong to (#1272 E-④). Used only to namespace the
   *  collision id: a mosaic's regions have independent (col,row) grids, so without it two
   *  domains would share a cell identity and fade each other out. The LAYER name is
   *  deliberately NOT namespaced — that is the collision pass's precedence bucket. */
  region: string
  /** The layer's `filter:` clause, or absent for an unfiltered layer. */
  filter?: { ast: unknown } | null
  /** Live camera zoom, so a `zoom`-dependent filter sees it — same value the pass hands the
   *  label text / size / colour expressions. */
  cameraZoom?: number
}

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
  opts: SoundingDispatchOptions,
): void {
  const anchors = coverageSoundingAnchors(handle, unproject, {
    width: viewport.width,
    height: viewport.height,
    spacingPx: SOUNDING_LATTICE_CSS_PX * viewport.dpr,
  })
  // `filter:` reaches a coverage layer's NUMERALS here (GeoJSON is pre-filtered into its own
  // FeatureCollection and vector tiles fold the filter into the worker slice key; a grid is
  // neither). The cell's bands are the property bag, so `.depth > 20` reads as it would on a
  // feature.
  //
  // The SHARED predicate comes first (#1437): when the clause compiles to the coverage
  // fragment predicate, this arm runs that same IR through the DSL's CPU backend, so a layer
  // drawing both a ramp and numerals cannot filter them differently. When it does not compile
  // — a string operand, two bands, a form only a property bag can answer — the general AST
  // evaluator still applies. That fallback is never reached by a layer that also drapes: the
  // ramp arm REFUSES an uncompilable predicate outright, so the two evaluators are never both
  // live for one clause.
  const shared = coverageCellPredicate(opts.filter, opts.cameraZoom ?? 0)
  for (const a of anchors) {
    if (shared) {
      if (!shared(a.values)) continue
    } else if (!filterAcceptsProps(opts.filter, a.values, opts.cameraZoom)) continue
    const def = applyFeatureExprs(a.values)
    for (const projected of projectLonLatCopies(a.lon, a.lat)) {
      addLabel(
        def.text,
        a.values,
        projected[0],
        projected[1],
        def,
        undefined,
        opts.layerName,
        undefined,
        // CELL identity, not anchor position: the screen anchor moves every frame while
        // the cell does not, so a numeral fades across camera moves instead of popping.
        `${opts.layerName}:${opts.region}:${a.col},${a.rowFromSouth}`,
        projected[2],
      )
    }
  }
}

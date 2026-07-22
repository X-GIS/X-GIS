// ═══ IR types — S-100 coverage LAYER paint concern (#1158 GAP-1 / INC-D) ═══
//
// The `coverage` colour-ramp display axes, factored out of render-node.ts to keep
// that god-file under its LOC ceiling (mirrors render-node-hillshade.ts's
// RenderNodeHillshadePaint split). A type-only interface `render-node.ts`
// re-composes via `extends` on the RenderNode.
//
// INC-D placement (the graduation the SOURCE-level INC-A note promised): `ramp` /
// `range` are STYLING (how a value maps to colour), so they are LAYER PAINT — the
// exact analogue of Mapbox's `raster-color` / `raster-color-range` (paint on the
// raster LAYER, never on the source). The `coverage` source is data-only; the layer
// that draws it carries the palette + window, so two layers can style one coverage
// differently. `lowerLayer` threads these off the `layer` block.

/** `coverage` (S-100 gridded) LAYER paint axes, threaded from the `layer` block so the
 *  coverage colour-ramp renderer arms with the author's palette + value window.
 *  Undefined for non-coverage layers. `RenderNode extends` this. */
export interface RenderNodeCoveragePaint {
  /** Named colour-ramp LUT (map color-ramp.ts RAMPS key, e.g. `"bathymetry"`,
   *  `"viridis"`). An unknown name fails loudly at arm time. Default viridis. */
  ramp?: string
  /** `[lo, hi]` display value window mapped across the ramp. Values outside
   *  clamp to the ramp ends. Default = the band's data range. */
  range?: readonly [number, number]
}

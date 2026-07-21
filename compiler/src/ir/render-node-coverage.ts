// ═══ IR types — S-100 coverage source concern (#1158 GAP-1) ═══
//
// The `type: coverage` SourceDef fields, factored out of render-node.ts to keep
// that god-file under its LOC ceiling (mirrors render-node-hillshade.ts's
// RasterDemSourceFields split). A type-only interface `render-node.ts`
// re-composes via `extends`.

/** `type: coverage` (.xgcov) display options, threaded from the source block so
 *  the coverage colour-ramp renderer arms with the author's palette + value
 *  window (language.ts SOURCE_OPTIONS `ramp` / `range`; graduate to paint
 *  properties in INC-D). Undefined for non-coverage sources. `SourceDef
 *  extends` this. */
export interface CoverageSourceFields {
  /** Named colour-ramp LUT (map color-ramp.ts RAMPS key, e.g. `"bathymetry"`,
   *  `"viridis"`). An unknown name fails loudly at arm time. Default viridis. */
  ramp?: string
  /** `[lo, hi]` display value window mapped across the ramp. Values outside
   *  clamp to the ramp ends. Default = the band's data range. */
  range?: readonly [number, number]
}

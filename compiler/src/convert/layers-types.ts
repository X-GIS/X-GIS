// ═══ Mapbox layer → xgis conversion: shared types ═══
// Type/interface declarations extracted from layers.ts so the converter
// module stays focused on logic. These are internal to the convert layer
// pipeline (none were part of layers.ts's public export surface).

/** Symbol layer (Mapbox text labels + icons). Batch 1b emits text
 *  intent; Batch 1c wires the renderer; Batch 2 adds icons. For now,
 *  text-field becomes `label-[<expr>]` and text-color maps to a
 *  fill utility — the IR's `label?` field captures the rest. */
export interface SymbolLayerOverrides {
  /** Override the layer id (used when splitting one Mapbox layer
   *  into multiple xgis blocks for zoom-step symbol-placement). */
  idSuffix?: string
  /** Constant `symbol-placement` value to use, bypassing the value
   *  read from `layout`. Used by the step expansion. */
  placement?: 'point' | 'line' | 'line-center'
  /** Override `minzoom` / `maxzoom` on the emitted block (the layer's
   *  own minzoom/maxzoom is overlaid by the step segment range). */
  minzoom?: number
  maxzoom?: number
}

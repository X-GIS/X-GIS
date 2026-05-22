// ═══ AST → IR Lowering: shared types ═══
// Type/interface declarations extracted from lower.ts so the lowering
// pipeline module stays focused on logic. Public types are re-exported
// from lower.ts to keep the module's public surface unchanged.

/** Lower-pass options. Reserved for opt-in features that change the
 *  IR shape produced from a given AST — bypass flags for collapses
 *  that exist because a runtime feature wasn't available yet. */
export interface LowerOptions {
  /** Skip `extractMatchDefaultColor` for fill bindings (the second
   *  Mapbox `match(.field) { ..., _ -> default }` collapse — see
   *  `convert/mapbox-to-xgis.ts:bypassExpandColorMatch` for the
   *  first). When true, the match() expression survives as
   *  `kind: 'data-driven'` so the P4 compute path (or the fragment-
   *  shader if-else fallback for variants with per-feature props)
   *  evaluates every arm GPU-side.
   *
   *  Default false (preserves existing collapse-to-default
   *  behaviour). Combined with `bypassExpandColorMatch: true`,
   *  this is the second half of the gate that lets Mapbox styles
   *  flow large match() expressions into the compute path. Without
   *  the runtime support (VTR compute integration), the lowered
   *  data-driven shape STILL renders correctly via the existing
   *  fragment-shader if-else path for any source that has a
   *  populated PropertyTable + variant.featureFields wired in
   *  (commit ba348aa). */
  bypassExtractMatchDefaultColor?: boolean
}

/** Result of pulling stops out of an `interpolate(...)` /
 *  `interpolate_exp(...)` binding. `base === 1` indicates the linear
 *  branch (i.e. `interpolate(zoom, …)` with no explicit curve). */
export interface ZoomStopsWithBase<T> {
  base: number
  stops: Array<{ zoom: number; value: T }>
}

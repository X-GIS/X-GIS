// ═══ AST → IR Lowering: shared types ═══
// Type/interface declarations extracted from lower.ts so the lowering
// pipeline module stays focused on logic. Public types are re-exported
// from lower.ts to keep the module's public surface unchanged.

/** Lower-pass options. Reserved for opt-in features that change the
 *  IR shape produced from a given AST — bypass flags for collapses
 *  that exist because a runtime feature wasn't available yet. */
export interface LowerOptions {
}

/** Result of pulling stops out of an `interpolate(...)` /
 *  `interpolate_exp(...)` binding. `base === 1` indicates the linear
 *  branch (i.e. `interpolate(zoom, …)` with no explicit curve). */
export interface ZoomStopsWithBase<T> {
  base: number
  stops: Array<{ zoom: number; value: T }>
}

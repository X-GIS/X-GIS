// ═══ Expression Evaluator: shared types ═══
// Type declarations extracted from evaluator.ts so the evaluator
// module stays focused on logic. Behaviour-identical move; the
// public surface (FeatureProps, FnEnv) is re-exported from
// evaluator.ts.

import type * as AST from '../parser/ast'

/** A bag of feature properties (e.g., from GeoJSON properties). The
 *  reserved key {@link CAMERA_ZOOM_KEY} (`$zoom`) carries the current
 *  camera zoom level when the caller wants `zoom`-keyed builtins
 *  (`interpolate(zoom, …)`) to evaluate to a concrete number. Callers
 *  that don't supply that key get null for the `zoom` identifier —
 *  same shape as a missing feature property. */
export type FeatureProps = Record<string, unknown>

/** Environment of user-defined functions for compile-time evaluation */
export type FnEnv = Map<string, AST.FnStatement>

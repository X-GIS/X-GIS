// Shared types for the per-cluster expression-handler registry.
//
// `exprToXgis` (expressions.ts) is a thin dispatcher: it owns the
// recursion-depth guard + the scalar prelude + the unsupported-op
// fallback table, then looks up a per-op handler in a Map assembled
// from the per-cluster modules (expr-arithmetic / expr-logic /
// expr-lookup / expr-string). Each handler is the verbatim body of
// the original switch arm; to avoid an import cycle it receives the
// two recursion entrypoints as parameters rather than importing
// expressions.ts.

/** Recurse into the expression converter (the public `exprToXgis`). */
export type Recurse = (x: unknown, w: string[]) => string | null

/** Recurse into the filter converter (the public `filterToXgis`),
 *  used by the `all` / `any` / `!` arms. */
export type RecurseFilter = (x: unknown, w: string[]) => string | null

/** A per-op handler: the verbatim body of one `switch(op)` arm.
 *  `v` is the operator array (`v[0]` is the op string). */
export type ExprHandler = (
  v: unknown[],
  warnings: string[],
  recurse: Recurse,
  recurseFilter: RecurseFilter,
  op: string,
) => string | null

// ═══ @xgis/pipeline · load — the declarative orchestrator ═══
//
// The essence surface: WHICH data → HOW it loads → HOW it shows, in one call. It is a
// STRICT re-composition of the pure verbs — join()/where()/groupBy()/bubble() — and coins
// NO new vocabulary: every LoadSpec field is a shipped symbol or a data-first thunk over
// one. So `load` has exactly one mental model (the four stages), the composable form stays
// the substrate, and the `as` join-handle contract cannot drift (JoinSpec is pinned to
// join's own parameter). See docs/architecture/data-to-viz-pipeline.md §2b/§5.

import { type Table } from './core/table'
import { join } from './join'
import { type EncodeResult } from './encode'

/** `join`'s own 2nd parameter — pinned so the join contract, including the `as` handle that
 *  mints `${as}.lon`/`.lat`, CANNOT drift from the verb `load` delegates to. */
export type JoinSpec = Parameters<typeof join>[1]

export interface LoadSpec {
  /** WHICH — an ingested Table, e.g. `fromCSV(text, { vintage })`. */
  from: Table
  /** HOW loaded → geometry. One join, or an array applied left-to-right (odFlow's
   *  origin+dest double-join); each spec carries its own `as` handle. */
  join?: JoinSpec | readonly JoinSpec[]
  /** Data-first stages over the shipped verbs, authored `t => where(t, {...})`; run in order. */
  transform?: ReadonlyArray<(t: Table) => Table>
  /** HOW shown — a shipped encoder, authored `t => bubble(t, {...})`. */
  show: (t: Table) => EncodeResult
}

/** Run a declarative spec: from → join(s) → transform(s) → show. A thin, pure
 *  re-composition of the verbs; the returned EncodeResult is applied with `.apply(sink, id)`
 *  exactly like the composable form. */
export function load(spec: LoadSpec): EncodeResult {
  let t = spec.from
  if (spec.join !== undefined) {
    const joins = (Array.isArray(spec.join) ? spec.join : [spec.join]) as readonly JoinSpec[]
    for (const j of joins) t = join(t, j)
  }
  if (spec.transform !== undefined) {
    for (const stage of spec.transform) t = stage(t)
  }
  return spec.show(t)
}

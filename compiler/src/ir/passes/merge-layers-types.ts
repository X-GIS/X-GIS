// ═══ IR Layer Merge Pass — shared types ═══
//
// Top-level types extracted from `merge-layers.ts` so the pure
// helpers and the stateful pass core can share them without a
// circular dependency. Internal to the merge pass; not part of the
// compiler's public surface.

/** One equality-tested literal value from a filter clause, paired
 *  with the source AST literal kind. `raw` is the stringified value
 *  (the match-arm pattern key and the set-equality / dedup key — those
 *  compare by string and are unaffected by type). `wasString` records
 *  whether the source literal was a StringLiteral (`true`) or a
 *  NumberLiteral (`false`), so `buildOrFilter` can re-emit the SAME
 *  node kind instead of re-guessing via `Number()`. Re-guessing turned
 *  a source `.class == "1"` (StringLiteral) into `.class == 1`
 *  (NumberLiteral); under the evaluator's strict `===`, a feature with
 *  `class: "1"` then failed `"1" === 1` and was dropped by the merged
 *  compound's pre-bucket OR-filter even though the unmerged layer
 *  matched it. */
export interface FilterValue {
  raw: string
  wasString: boolean
}

export interface FilterAnalysis {
  field: string
  values: FilterValue[]
}

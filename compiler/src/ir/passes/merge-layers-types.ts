// ═══ IR Layer Merge Pass — shared types ═══
//
// Top-level types extracted from `merge-layers.ts` so the pure
// helpers and the stateful pass core can share them without a
// circular dependency. Internal to the merge pass; not part of the
// compiler's public surface.

export interface FilterAnalysis {
  field: string
  values: string[]
}

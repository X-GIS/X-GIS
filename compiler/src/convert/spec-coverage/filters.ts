import type { CoverageEntry } from './types'

// ─── 7. Filter operators (legacy + expression form) ──────────────────
export const FILTERS: readonly CoverageEntry[] = [
  { name: '== / != / < / <= / > / >= (legacy form)', status: 'supported', note: 'Field-as-second-arg shape recognised.', source: 'expressions.ts:420' },
  { name: 'in / !in (legacy + expression form)',     status: 'supported' },
  { name: 'has / !has',                              status: 'supported' },
  { name: 'all / any / !',                           status: 'supported' },
  { name: 'match (boolean form)',                    status: 'supported', note: 'Lowers to OR/AND chain when all values are boolean literals.', source: 'expressions.ts:335' },
  { name: '$type',                                   status: 'supported', note: 'Legacy filter — routes to geometry-type accessor (get("$geometryType")).', source: 'expressions.ts' },
  { name: '$id',                                     status: 'supported', note: 'Legacy filter — routes to id accessor (get("$featureId")).', source: 'expressions.ts' },
]

// Build-time derivation of the Mapbox spec-coverage figures the site
// quotes (home Coverage band, /why, /roadmap, /docs/mapbox-spec). ONE
// derivation from the compiler's MAPBOX_COVERAGE authority
// (compiler/src/convert/spec-coverage/*) so pages can never drift apart
// again — they previously each hardcoded a snapshot and disagreed.
import { MAPBOX_COVERAGE } from '@xgis/compiler'

const totals = { supported: 0, partial: 0, unsupported: 0, na: 0 }
for (const section of MAPBOX_COVERAGE) {
  for (const e of section.entries) totals[e.status]++
}

/** Denominator every page quotes: n/a rows (Mapbox-only concepts with no
 *  xgis equivalent) are excluded — "X of Y applicable", never "of all". */
const applicable = totals.supported + totals.partial + totals.unsupported

export const coverage = {
  ...totals,
  /** All rows including n/a — the full table row count. */
  total: applicable + totals.na,
  applicable,
  /** Whole-number % of applicable properties fully supported. */
  pctSupported: Math.round((totals.supported / applicable) * 100),
} as const

#!/usr/bin/env bun
// emit-gap-matrix — generate a Markdown report of the current
// compiler-vs-runtime support matrix from the in-repo tables.
// Output: gap-matrix.md next to this script.
//
// Cross-references compiler/src/convert/spec-coverage.ts (Mapbox
// spec property/operator support status) and runtime/src/
// capabilities.ts (per-variant runtime honour status) so
// contributors see at a glance:
//   * which spec properties have compiler support but no runtime
//     row in the capability table (orphans)
//   * which capability rows are marked supported=false (gaps to
//     close)
//
// Run via:
//   bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md

import { flattenCoverage } from '../compiler/src/convert/spec-coverage'
import { RUNTIME_CAPABILITIES, runtimeGaps } from '../runtime/src/capabilities'

const lines: string[] = []
lines.push('# X-GIS Mapbox Support Gap Matrix')
lines.push('')
// Skip timestamp by default so re-running the generator doesn't
// churn the snapshot file with a per-second diff. Pass --timestamp
// when authoring a manual snapshot to capture the moment.
if (process.argv.includes('--timestamp')) {
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
}

// ───── Section 1: runtime capability gaps ─────
lines.push('## Runtime capability gaps')
lines.push('')
lines.push('Properties where the runtime currently degrades or drops a specific value-form.')
lines.push('')
lines.push('| Layer | Property | Variant | Note |')
lines.push('|---|---|---|---|')
for (const gap of runtimeGaps()) {
  lines.push(`| ${gap.layerType} | ${gap.property} | ${gap.variant} | ${gap.note ?? ''} |`)
}
lines.push('')

// ───── Section 2: spec-coverage status breakdown ─────
const cov = flattenCoverage()
const byStatus = {
  supported: cov.filter(e => e.status === 'supported').length,
  partial: cov.filter(e => e.status === 'partial').length,
  unsupported: cov.filter(e => e.status === 'unsupported').length,
  na: cov.filter(e => e.status === 'na').length,
}
lines.push('## Spec-coverage status breakdown')
lines.push('')
lines.push(`| Status | Count |`)
lines.push(`|---|---:|`)
lines.push(`| supported | ${byStatus.supported} |`)
lines.push(`| partial | ${byStatus.partial} |`)
lines.push(`| unsupported | ${byStatus.unsupported} |`)
lines.push(`| na | ${byStatus.na} |`)
lines.push(`| **total** | **${cov.length}** |`)
lines.push('')

// ───── Section 3: high-impact unsupported entries ─────
lines.push('## High-impact unsupported entries')
lines.push('')
lines.push('Properties marked `unsupported` with `impact: high` — these are the most visible gaps to close next.')
lines.push('')
lines.push('| Property | Note |')
lines.push('|---|---|')
for (const e of cov) {
  if (e.status === 'unsupported' && e.impact === 'high') {
    lines.push(`| ${e.name} | ${e.note ?? ''} |`)
  }
}
lines.push('')

// ───── Section 4: partial entries (most actionable) ─────
lines.push('## Partial entries')
lines.push('')
lines.push('Properties marked `partial` — converter accepts but runtime degrades. These need either runtime extension or downgrading to `unsupported`.')
lines.push('')
lines.push('| Property | Impact | Note |')
lines.push('|---|---|---|')
for (const e of cov) {
  if (e.status === 'partial') {
    lines.push(`| ${e.name} | ${e.impact ?? '-'} | ${e.note ?? ''} |`)
  }
}
lines.push('')

// Emit to stdout — caller redirects to gap-matrix.md.
process.stdout.write(lines.join('\n'))

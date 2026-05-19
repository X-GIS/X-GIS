// gap-matrix.md freshness gate. Re-runs the generator in-process and
// compares against the committed snapshot. Catches the regression
// class where someone updates spec-coverage.ts or capabilities.ts
// without regenerating the snapshot, leaving docs stale.
//
// Regenerate via:
//   bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { flattenCoverage } from '../../../compiler/src/convert/spec-coverage'
import { runtimeGaps } from '../capabilities'

const SNAPSHOT_PATH = join(__dirname, '..', '..', '..', 'scripts', 'gap-matrix.md')

// Inline the generator logic so we don't shell out (CI determinism).
// Mirror of scripts/emit-gap-matrix.ts default mode (no --timestamp).
function generateGapMatrix(): string {
  const lines: string[] = []
  lines.push('# X-GIS Mapbox Support Gap Matrix')
  lines.push('')

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

  return lines.join('\n')
}

describe('gap-matrix freshness', () => {
  it('scripts/gap-matrix.md matches the live generator output', () => {
    const expected = generateGapMatrix()
    const actual = readFileSync(SNAPSHOT_PATH, 'utf8')
    // Normalize line endings so the test passes regardless of git
    // autocrlf settings on Windows hosts.
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').trimEnd()
    expect(
      normalize(actual),
      'Regenerate scripts/gap-matrix.md via: bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md',
    ).toBe(normalize(expected))
  })
})

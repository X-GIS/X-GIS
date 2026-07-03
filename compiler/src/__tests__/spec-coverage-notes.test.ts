// Every spec-coverage entry marked `partial` or `unsupported` must
// carry a `note` explaining WHY the gap exists + what closing it
// requires. Documentation-only gate — empty notes hide intent and
// make the gap matrix less actionable.

import { describe, expect, it } from 'vitest'
import { flattenCoverage } from '../convert/spec-coverage'

describe('spec-coverage note coverage', () => {
  it('every partial / unsupported entry has a non-empty note', () => {
    const missing = flattenCoverage().filter(
      (e) =>
        (e.status === 'partial' || e.status === 'unsupported') && (!e.note || e.note.length === 0),
    )
    expect(
      missing.map((e) => e.name),
      `${missing.length} entries lack notes`,
    ).toEqual([])
  })

  it('partial / unsupported notes are at least 20 characters (meaningful detail)', () => {
    // supported / na entries have terse notes by design (e.g.
    // "Heatmap-only." for a na entry — fully descriptive in
    // context). partial / unsupported notes are load-bearing — they
    // tell contributors WHY the gap exists and what closing it
    // requires, so they should be substantive.
    const shallow: string[] = []
    for (const e of flattenCoverage()) {
      if (!e.note) continue
      if (e.status !== 'partial' && e.status !== 'unsupported') continue
      if (e.note.length < 20) shallow.push(`${e.name} (${e.status}): "${e.note}"`)
    }
    expect(shallow, shallow.join('\n')).toEqual([])
  })
})

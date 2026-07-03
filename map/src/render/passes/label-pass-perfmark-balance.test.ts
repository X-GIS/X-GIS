// label-pass GeoJSON label-show perf-mark balance
//
// The per-show loop opens perfMarkStart('encoder.label-dispatch.show') at
// the top of `for (const show of labelShows)` and closes it with a single
// perfMarkEnd at the loop tail. The GeoJSON / inline-data branch
// (`if (data && data.features && !_vectorTile)`) ends with `continue`,
// which skips the loop tail and therefore the markEnd. perf-marks.ts's
// markStart overwrites startTs unconditionally, so the NEXT show's
// markStart swallows the unbalanced GeoJSON show's interval — its
// dispatch time is never recorded.
//
// Two-part test (mirrors background-pass-clear-value.test.ts: behaviour +
// source-text guard):
//   1. Behaviour — pin the swallow at the perf-marks layer: an unbalanced
//      markStart loses the first sample (ONE recorded where balanced makes
//      TWO). This is the mechanism the fix removes; stable before/after.
//   2. Source-text guard — assert the GeoJSON branch closes the mark before
//      `continue`. FAILS on unpatched code (no markEnd in that branch),
//      PASSES after the perfMarkEnd is inserted at ~line 452.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  markStart,
  markEnd,
  getPhaseAverages,
  resetPhaseTimings,
  setPerfMarksEnabled,
} from '@xgis/map'

beforeEach(() => {
  setPerfMarksEnabled(true)
  resetPhaseTimings()
})

describe('perf-marks — unbalanced markStart swallows a sample', () => {
  it('an unmatched markStart (the `continue` case) loses the first interval', () => {
    // Mimic the buggy path: a show opens the mark but `continue` skips its
    // markEnd, then the NEXT show opens the mark again (overwriting startTs)
    // and closes it normally.
    markStart('s') // GeoJSON show — no end (continue skips it)
    markStart('s') // next show — startTs overwritten
    markEnd('s') // closes only the SECOND start
    const sUnbalanced = getPhaseAverages().find((p) => p.name === 's')
    expect(sUnbalanced?.samples).toBe(1) // first start swallowed

    // Balanced control: two shows that BOTH close their mark record TWO.
    resetPhaseTimings()
    markStart('b')
    markEnd('b')
    markStart('b')
    markEnd('b')
    const sBalanced = getPhaseAverages().find((p) => p.name === 'b')
    expect(sBalanced?.samples).toBe(2)
  })
})

// ── Guard: the GeoJSON label-show branch closes its mark before `continue` ──

// Normalise CRLF→LF: the repo checks out with autocrlf on Windows, so the
// raw bytes carry `\r\n`; the slice anchors below match on `\n` boundaries.
const LABEL_PASS_SRC = readFileSync(resolve(__dirname, 'label-pass.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
)

describe('label-pass — GeoJSON label-show branch balances its perf-mark', () => {
  it('the rawDatasets (Path 1) branch closes label-dispatch.show before `continue`', () => {
    // Slice the GeoJSON branch: from its opener to the first `continue`.
    const start = LABEL_PASS_SRC.indexOf('const data = host.rawDatasets.get(show.targetName)')
    expect(start).toBeGreaterThan(-1)
    // Indentation-robust: match the branch-level `continue` (a bare statement on
    // its own line) regardless of nesting depth, so re-formatting never breaks
    // this guard. Inline `... ) continue` (the per-feature skips) don't match.
    const rel = LABEL_PASS_SRC.slice(start).search(/\n[ \t]*continue\n/)
    expect(rel).toBeGreaterThan(-1)
    const continueIdx = start + rel
    const branch = LABEL_PASS_SRC.slice(start, continueIdx)
    // The loop-tail (~1022) makes this same call; the `continue` here must
    // mirror it or the show's dispatch sample is swallowed by the next show.
    expect(branch).toContain("perfMarkEnd('encoder.label-dispatch.show')")
  })
})

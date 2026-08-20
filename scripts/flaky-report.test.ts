// ═══ The flake detector, pinned against REAL Playwright output (#1924) ═══
//
// Every fixture below is copied from a shard log of an actual run on 2026-08-20, not
// hand-written to match the parser. Two of them are the flakes that prompted #1924; the
// other two are the shapes a careless detector gets WRONG, which is why they are here.
//
// The decoy that matters is `TEST_FAIL_SHARD`. It carries a `✘` and its totals still add
// up to all-passed, and the first pass at this work read that as "failed, retried,
// passed" and filed it as a third flake. It is not one: the spec is declared
// `test.fail()`, so failing IS its expected outcome and Playwright counts it as a pass.
// A detector keyed on the `✘` glyph reports every expected-failure test in the suite,
// forever. That arm is the reason this parser reads Playwright's own `flaky` accounting
// and nothing else.

import { describe, it, expect } from 'vitest'
import { parseFlaky, renderReport } from './flaky-report.js'

// run 32357088141, render-shard (1/4), PR #1927 — `_globe-dateline-wired-gate` failed
// twice and passed on the second retry. Kept WITH the retry lines above the summary,
// because those are what a person would otherwise have to find by hand.
const DATELINE_FLAKE = `
  ✘  64 [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline renders the Pacific hemisphere (2.1m)
  ✘  65 [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline renders the Pacific hemisphere (retry #1) (2.1m)
  ✓  66 [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline renders the Pacific hemisphere (retry #2) (34.5s)

  1 flaky
    [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline renders the Pacific hemisphere
  69 passed (27.7m)
`

// run 32350280490, render-shard (1/4), PR #1920 — a visual-parity gate disagreeing with
// its own baseline on the first attempt.
const COMPUTE_PARITY_FLAKE = `
  1 flaky
    [chromium] › e2e/_compute-path-continent-match.spec.ts:112:5 › Plan P4 — broader fixture coverage with ?compute=1 › continent_outlines — compute=1 visual matches compute=0 baseline
  69 passed (22.8m)
`

// run 32357088141, render-shard (2/4) — a clean shard. Must produce no noise at all.
const CLEAN_SHARD = `
  ✓  70 [chromium] › e2e/_ortho-tilt-backface.spec.ts:79:3 › ortho pitch=60: front line remains visible (7.5s)

  70 passed (8.5m)
`

// run 32350280490, render-shard (4/4) — THE DECOY. `_water-hierarchy-pitch.spec.ts:100`
// is declared `test.fail(...)`, so its failure is expected and counted as a pass: a `✘`
// with no retry, no `flaky` line, and totals that reach the full 70.
const TEST_FAIL_SHARD = `
  -  48 [chromium] › e2e/_water-hierarchy-pitch.spec.ts:90:6 › water_hierarchy at moderate pitch (34°) does not sustain FLICKER warnings
  ✘  49 [chromium] › e2e/_water-hierarchy-pitch.spec.ts:100:6 › water_hierarchy at high pitch (80°) does not sustain FLICKER warnings (22.5s)
  ✓  50 [chromium] › e2e/_webgl2-frame-close-gate.spec.ts:61:1 › a driven WebGL2 frame reaches the END of render(), not just the start (#1480) (9.6s)

  1 skipped
  69 passed (6.7m)
`

// The shard logs are colourised — the step pipes a TTY-style reporter through `tee`.
const ANSI_FLAKE =
  '\n  \u001b[31m1 flaky\u001b[39m\n' +
  '    \u001b[2m[chromium] › e2e/_foo-gate.spec.ts:7:1 › a thing\u001b[22m\n' +
  '  \u001b[32m69 passed\u001b[39m (1.0m)\n'

// Two entries, then the summary and a trailing slow-test note — the shape that
// distinguishes a parser which stops from one which keeps reading.
const TWO_FLAKY_THEN_MORE = `
  2 flaky
    [chromium] › e2e/_a-gate.spec.ts:1:1 › first
    [chromium] › e2e/_b-gate.spec.ts:2:1 › second
  68 passed (9.9m)

  Slow test file: e2e/_c-gate.spec.ts (1.2m)
`

// The SAME dateline flake as downloaded from the job-log API, which prefixes every line
// with an ISO timestamp. The unit fixtures above are `tee`'d stdout — the shape CI writes
// — and passing on those alone is exactly the "every test passed offset zero" trap: the
// first smoke run of this script against the real 88 KB log reported ZERO flakes.
const TIMESTAMPED_FLAKE = `
2026-08-20T10:34:49.2513509Z   1 flaky
2026-08-20T10:34:49.2514061Z     [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline renders the Pacific hemisphere
2026-08-20T10:34:49.2514609Z   69 passed (27.7m)
`

describe('parseFlaky — Playwright’s own accounting is the authority', () => {
  it('reports the dateline flake with its location', () => {
    const r = parseFlaky(DATELINE_FLAKE)
    expect(r.count).toBe(1)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.location).toBe('e2e/_globe-dateline-wired-gate.spec.ts:102:1')
    expect(r.entries[0]!.title).toContain('renders the Pacific hemisphere')
  })

  it('reports the compute-parity flake, whose title spans a describe chain', () => {
    const r = parseFlaky(COMPUTE_PARITY_FLAKE)
    expect(r.count).toBe(1)
    expect(r.entries[0]!.location).toBe('e2e/_compute-path-continent-match.spec.ts:112:5')
  })

  it('is silent on a clean shard', () => {
    expect(parseFlaky(CLEAN_SHARD)).toEqual({ count: 0, entries: [] })
  })

  // The arm that decides the design. A `✘`-keyed detector reports this; the real one
  // must not, because `test.fail()` failing IS the pass.
  it('does NOT report a `test.fail()` expected failure, ✘ glyph and all', () => {
    expect(TEST_FAIL_SHARD).toContain('✘') // the fixture really does carry the glyph
    expect(parseFlaky(TEST_FAIL_SHARD)).toEqual({ count: 0, entries: [] })
  })

  it('parses a DOWNLOADED job log, ISO timestamp prefix and all', () => {
    const r = parseFlaky(TIMESTAMPED_FLAKE)
    expect(r.count).toBe(1)
    expect(r.entries[0]!.location).toBe('e2e/_globe-dateline-wired-gate.spec.ts:102:1')
  })

  it('parses a colourised log the same as a plain one', () => {
    const r = parseFlaky(ANSI_FLAKE)
    expect(r.count).toBe(1)
    expect(r.entries[0]!.location).toBe('e2e/_foo-gate.spec.ts:7:1')
  })

  // The previous version of this arm asserted "no entry contains the word passed",
  // which held whether or not the parser terminated the block — it was cut and
  // reddened nothing. This one counts: the fixture carries TWO titles and then more
  // run output, so a parser that fails to stop collects more than two.
  it('collects exactly the titles in the block, not the run output after it', () => {
    const r = parseFlaky(TWO_FLAKY_THEN_MORE)
    expect(r.count).toBe(2)
    expect(r.entries.map((e) => e.location)).toEqual([
      'e2e/_a-gate.spec.ts:1:1',
      'e2e/_b-gate.spec.ts:2:1',
    ])
  })
})

describe('renderReport — surfaces, does not gate', () => {
  it('emits a warning annotation naming the spec, and a summary table', () => {
    const { annotations, summary } = renderReport(parseFlaky(DATELINE_FLAKE), 'render-shard 1/4')
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toContain('::warning title=Flaky test (render-shard 1/4)::')
    expect(annotations[0]).toContain('e2e/_globe-dateline-wired-gate.spec.ts:102:1')
    // The annotation has to say WHY a green check is not the whole story, or a reader
    // who sees it on a passing run has no reason to care.
    expect(annotations[0]).toContain('GREEN')
    expect(summary).toContain('1 flaky test')
    expect(summary).toContain('| location | test |')
  })

  it('adds nothing at all when there is nothing to report', () => {
    expect(renderReport(parseFlaky(CLEAN_SHARD), 'render-shard 2/4')).toEqual({
      annotations: [],
      summary: '',
    })
  })
})

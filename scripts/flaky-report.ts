#!/usr/bin/env bun
// ═══ A retry-masked flake leaves NO trace anywhere a person looks (#1924) ═══
//
//   bun scripts/flaky-report.ts <playwright-log> [label]
//
// `playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`. A spec that fails and
// then passes on retry therefore exits **0**, the shard step's `exit "$rc"` propagates
// that 0, and the check run concludes `success`. MEASURED on the check-run API: that
// success carries `output.title`, `output.summary` and `output.text` as EMPTY STRINGS —
// there is no field a flake could appear in. The only record is one line in a ~96 KB
// single-line log of a 27-minute job, and nobody opens the log of a green run.
//
// Two flakes went unrecorded that way on 2026-08-20 alone, and were found only because
// a shard log was being read to prove something unrelated. The second one is why this
// matters: `_globe-dateline-wired-gate` is the spec #1897 rewrote to REMOVE a flake, and
// it flaked again invisibly — a fix that recurs silently still looks like a fix.
//
// This does NOT change the retry policy. Retries are a deliberate choice (see the
// `retries` note in playwright.config.ts): ~46 SwiftShader render/readback gates on a
// shared cloud runner. The defect is not that CI retries, it is that a retry leaves no
// trace. So: surface, do not fail.
//
// ── WHY THE `flaky` SUMMARY LINE AND NOT THE `✘` GLYPH ──
// The obvious detector — "a ✘ appeared, so something failed and was retried" — is WRONG,
// and it was tried: `test.fail()` (an expected-failure marker, e.g.
// `_water-hierarchy-pitch.spec.ts:100`) prints `✘` on its HAPPY path and is counted as a
// pass. Keying on the glyph reports every expected-failure test in the suite as a flake,
// forever. Playwright's own `N flaky` accounting already excludes `test.fail` and
// `test.fixme` and is emitted exactly when a test failed and then passed on retry, so it
// is the authority here. This script adds no judgment of its own — it surfaces an
// accounting that already exists and that the check-run API discards.

import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'

/** One flaky entry as Playwright's list reporter spells it in the run summary. */
export interface FlakyEntry {
  /** The full title line, e.g. "[chromium] › e2e/_foo.spec.ts:12:1 › does a thing". */
  readonly title: string
  /** `e2e/_foo.spec.ts:12:1` when the title carries one — for grouping and links. */
  readonly location?: string
}

/** The run's flaky block: the count Playwright reported and the titles under it.
 *
 *  Playwright prints, at the very end of a run:
 *
 *      1 flaky
 *        [chromium] › e2e/_globe-dateline-wired-gate.spec.ts:102:1 › globe @ dateline …
 *      69 passed (27.7m)
 *
 *  The titles are indented further than the count and each begins with `[`. `count` is
 *  read from the header rather than derived from the titles, so a truncated or
 *  ANSI-mangled tail reports a DISAGREEMENT instead of silently under-counting. */
export function parseFlaky(log: string): { count: number; entries: FlakyEntry[] } {
  // Strip ANSI so a colourised log parses the same as a piped one, and drop the ISO
  // timestamp GitHub prefixes to every line of a DOWNLOADED job log. In CI this script
  // reads `tee`'d Playwright stdout, which has neither — but a person chasing a flake
  // reads the downloaded log, which has both, and that is how these were found in the
  // first place. Measured: without the timestamp strip, the real 88 KB shard log that
  // provoked this script reported ZERO flakes while containing `1 flaky`.
  // ESC is what an ANSI sequence IS, so matching it is the point; the alternative
  // (building the class from a charCode) hides that from the reader for no gain.
  const lines = log
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''))
  const header = lines.findIndex((l) => /^\s*(\d+) flaky\s*$/.test(l))
  if (header === -1) return { count: 0, entries: [] }
  const count = Number(/^\s*(\d+) flaky\s*$/.exec(lines[header]!)![1])

  const entries: FlakyEntry[] = []
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]!
    // The block ends at the first line that is not a title. Every Playwright title line
    // begins with the project tag (`[chromium] › …`), and nothing else in the summary
    // does — not `69 passed (27.7m)`, not a `✓`/`✘`-prefixed result line. A second
    // guard keyed on the summary wording was tried and CUT: removing it reddened
    // nothing, because this check already owns the boundary.
    const title = line.trim()
    if (!title.startsWith('[')) {
      if (title === '') continue
      break
    }
    entries.push({ title, location: /(\S+\.spec\.ts:\d+:\d+)/.exec(title)?.[1] })
  }
  return { count, entries }
}

/** GitHub annotation + job-summary markdown for a flaky block. Empty when there is
 *  nothing to report, so a clean run adds no noise. */
export function renderReport(
  { count, entries }: { count: number; entries: FlakyEntry[] },
  label: string,
): { annotations: string[]; summary: string } {
  if (count === 0) return { annotations: [], summary: '' }

  const names = entries.map((e) => e.location ?? e.title)
  const annotations = [
    `::warning title=Flaky test (${label})::${count} test(s) passed only on retry: ` +
      `${names.join(', ')}. The check is GREEN because retries are on; this is the only ` +
      `notice you will get. See #1924.`,
  ]
  const rows = entries.map((e) => `| \`${e.location ?? '—'}\` | ${e.title} |`).join('\n')
  const summary = [
    `### ⚠️ ${count} flaky test${count === 1 ? '' : 's'} — ${label}`,
    '',
    'These failed and then passed on retry. The job is green; without this note the',
    'recurrence would leave no trace (#1924).',
    '',
    '| location | test |',
    '| --- | --- |',
    rows,
    '',
  ].join('\n')
  return { annotations, summary }
}

// ── CLI ──
// Reads the log, prints annotations to stdout (GitHub parses them from the step's
// output) and appends the markdown to $GITHUB_STEP_SUMMARY when running in Actions.
// Always exits 0: this reports, it does not gate.
if (import.meta.main) {
  const [path, label = 'render gates'] = process.argv.slice(2)
  if (path === undefined) {
    console.error('usage: bun scripts/flaky-report.ts <playwright-log> [label]')
    process.exit(2)
  }
  const { annotations, summary } = renderReport(parseFlaky(readFileSync(path, 'utf8')), label)
  for (const a of annotations) console.log(a)
  const out = process.env.GITHUB_STEP_SUMMARY
  if (summary !== '' && out !== undefined) appendFileSync(out, summary + '\n')
}

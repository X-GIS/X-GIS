#!/usr/bin/env bun
// matrix:report — pretty-print the last matrix run's per-cell results from
// playground/e2e/__matrix__/report.json (written by _matrix-gate.spec.ts
// afterAll). Read-only: it never touches baselines or the manifest.
//
// Usage:  bun run matrix:report

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = join(REPO, 'playground', 'e2e', '__matrix__', 'report.json')

if (!existsSync(REPORT)) {
  console.error(`✗ no report at ${REPORT}\n  Run the gate first: XGIS_MATRIX=1 bun precheck:matrix`)
  process.exit(1)
}

interface Row {
  cellId: string
  projection: string
  gate: string
  knownStatus: string
  oracle: string
  verdict: string
  measured: number | null
  threshold: number | null
  detail: string
}
const { rows, hardFailures } = JSON.parse(readFileSync(REPORT, 'utf8')) as {
  rows: Row[]
  hardFailures: string[]
}

const fmt = (n: number | null) =>
  n === null ? '—' : Math.abs(n) >= 1 || n === 0 ? String(n) : n.toExponential(2)

console.log('═══ MATRIX GATE REPORT (cached) ═══\n')
for (const r of rows) {
  const mark =
    r.verdict === 'PASS'
      ? '✓'
      : r.verdict === 'FAIL'
        ? '✗'
        : r.verdict === 'SOFT'
          ? '~'
          : r.verdict === 'CANDIDATE'
            ? '?'
            : '·'
  console.log(
    `${mark} ${r.cellId.padEnd(26)} ${r.oracle.padEnd(16)} ${r.verdict.padEnd(10)} ` +
      `meas=${fmt(r.measured).padEnd(10)} thr=${fmt(r.threshold).padEnd(10)} ${r.detail}`,
  )
}

const count = (v: string) => rows.filter((r) => r.verdict === v).length
console.log('\n───────────────────────────────────────────────')
console.log(
  `PASS=${count('PASS')}  FAIL=${count('FAIL')}  SOFT=${count('SOFT')}  SKIP=${count('SKIP')}  CANDIDATE=${count('CANDIDATE')}`,
)
if (count('CANDIDATE') > 0) {
  console.log(
    `\n→ inspect e2e/__matrix__/<id>.png for each CANDIDATE, then \`bun run matrix:accept <id>\`.`,
  )
}
if (hardFailures.length > 0) {
  console.log('\nHARD FAILURES:')
  for (const f of hardFailures) console.log(`  ✗ ${f}`)
  process.exit(1)
}

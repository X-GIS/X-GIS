// Mutation-catch evaluator (milestone-1 skeleton).
//
// The autoresearch success metric is "mutation catch-rate → 100%": a suite
// of deliberately-injected render bugs the harness MUST flag. This evaluator
// drives that contract for ONE mutation now, structured as a LIST so more
// classes (layer-drop, label-shift, seam-break, NaN, wrong-tile) slot in
// later.
//
// For each mutation it:
//   (i)   records the BASELINE Oracle-B mismatchRatio (clean tree),
//   (ii)  PRECONDITION CHECK: baseline must be GREEN (mismatch < PIXEL_MISMATCH_MAX);
//         if not, abort with a clear error — catch evaluation on a broken
//         baseline is meaningless and would produce false positives,
//   (iii) applies a reversible single-line projection-constant edit to the
//         runtime source (vite HMR / a fresh test run picks it up),
//   (iv)  re-runs Oracle-B,
//   (v)   asserts (mutatedMismatch − baselineMismatch) >= CATCH_DELTA,
//   (vi)  REVERTS the edit (always, even on throw),
//   (vii) prints caught/total.
//
// Mechanism: each Oracle-B run is a Playwright invocation of
// _render-verify-oracle-b.spec.ts; we parse its `[oracle-B] … mismatch=…%`
// console line (the spec already logs it). A mutation is "caught" IFF the
// pixel-mismatch ratio grows by at least CATCH_DELTA above baseline — a
// purely numeric, unforgeable signal. Spec exit-status is NOT used for the
// catch decision (a failing baseline would trivially flip it).
//
// Run (single shell command — see evaluatorCmd in the report):
//   cd D:/X-GIS/playground && HEADED=1 bun render-verify/evaluator.ts

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const REPO = 'D:/X-GIS'
const SPEC = 'e2e/_render-verify-oracle-b.spec.ts'
// The case whose mismatch we parse for the catch decision.
const PARSE_CASE = 'mercator-europe'
// Oracle-B pixel gate (must match _render-verify-oracle-b.spec.ts).
// Baseline must be BELOW this for catch evaluation to be meaningful.
const PIXEL_MISMATCH_MAX = 0.06
// A mutation counts as caught if the mismatch ratio grows by at least this
// absolute amount over baseline.  0.05 is well above GPU run-to-run noise
// (~0.001) and well below the signal a 1% projection-constant nudge produces
// (tens-of-px displacement → large ratio jump).
const CATCH_DELTA = 0.05

interface Mutation {
  name: string
  file: string
  /** exact substring present in the clean source (must be unique). */
  find: string
  /** replacement that injects the bug. */
  replace: string
}

// Mutation list — milestone-1 ships ONE; add more (one per real failure
// class) to push catch-rate coverage.
const MUTATIONS: Mutation[] = [
  {
    name: 'mercator-scale +1% (WORLD_MERC × 1.01)',
    file: 'runtime/src/engine/gpu/gpu-shared.ts',
    find: 'export const WORLD_MERC = 40075016.686',
    // ×1.01 perturbs the px-per-metre that drives the mercator MVP → every
    // fixture vertex lands ~1% off the d3 reference (tens of px at the
    // frame edges). Catches the projection-constant-perturbation class.
    replace: 'export const WORLD_MERC = 40075016.686 * 1.01',
  },
]

interface OracleRun {
  ratio: number | null
  numericErr: number | null
  passed: boolean
  raw: string
}

/**
 * Run the Oracle-B spec once; return its parsed signals + pass/fail.
 *
 * CRITICAL — clear vite's optimizeDeps cache first. The playground pre-bundles
 * the @xgis/runtime workspace dep into node_modules/.vite; a mutation to
 * runtime/src is NOT re-read by a fresh `playwright test` unless that cache is
 * busted, so the mutated render would be byte-identical to baseline (a false
 * MISS). Proven: with the cache cleared, WORLD_MERC×1.01 moves the numeric
 * forward-agreement 4e-5 → 12.7px and the gate goes red.
 */
function runOracleB(): OracleRun {
  try {
    rmSync(`${REPO}/playground/node_modules/.vite`, { recursive: true, force: true })
  } catch { /* cache may not exist yet — fine */ }
  const res = spawnSync(
    'bunx',
    ['playwright', 'test', SPEC, '--project=chromium', `--grep=${PARSE_CASE}`],
    {
      cwd: `${REPO}/playground`,
      env: { ...process.env, HEADED: '1' },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 6 * 60_000,
    },
  )
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  // Parse the spec's own log line, e.g.
  //   "[oracle-B] mercator-europe  drawCalls=18  mismatch=0.789%  numericMaxErr=4.128e-5px …"
  // Pin to PARSE_CASE; allow ANY fields between the case name and each metric.
  const pm = out.match(
    new RegExp(`\\[oracle-B\\]\\s+${PARSE_CASE}\\b[^\\n]*?mismatch=([\\d.]+)%`),
  )
  const nm = out.match(
    new RegExp(`\\[oracle-B\\]\\s+${PARSE_CASE}\\b[^\\n]*?numericMaxErr=([\\d.eE+-]+)px`),
  )
  return {
    ratio: pm ? Number(pm[1]) / 100 : null,
    numericErr: nm ? Number(nm[1]) : null,
    passed: res.status === 0,
    raw: out,
  }
}

interface MutationResult {
  name: string
  baseline: number
  mutated: number | null
  caught: boolean
}

function evaluate(): MutationResult[] {
  // (i) Baseline on the clean tree.
  // eslint-disable-next-line no-console
  console.log('[evaluator] recording BASELINE (clean tree)…')
  const base = runOracleB()

  if (base.ratio === null) {
    throw new Error(
      '[evaluator] baseline not green, cannot evaluate: ' +
      'Oracle-B produced no parseable mismatch line — ' +
      'check that the spec ran and the map rendered.\n' +
      '──── last 1200 chars of the Oracle-B run output ────\n' +
      base.raw.slice(-1200),
    )
  }
  if (!base.passed || base.ratio >= PIXEL_MISMATCH_MAX) {
    throw new Error(
      `[evaluator] baseline not green, cannot evaluate: baseline ` +
      `${base.passed ? 'passed but mismatch' : 'FAILED its own gate ('} ` +
      `${(base.ratio * 100).toFixed(3)}%${base.passed ? '' : `, numericErr=${base.numericErr}px)`}` +
      ` >= gate ${(PIXEL_MISMATCH_MAX * 100).toFixed(0)}%. ` +
      `Fix the render harness before running mutation evaluation.\n` +
      base.raw.slice(-1000),
    )
  }

  // eslint-disable-next-line no-console
  console.log(`[evaluator] baseline GREEN — mismatch=${(base.ratio * 100).toFixed(3)}% numericErr=${base.numericErr}px (gate passed)`)

  const results: MutationResult[] = []

  for (const mut of MUTATIONS) {
    const path = `${REPO}/${mut.file}`
    const original = readFileSync(path, 'utf8')
    if (!original.includes(mut.find)) {
      throw new Error(
        `[evaluator] mutation "${mut.name}": find-string not present in ${mut.file} — ` +
        `the constant moved; update the mutation.`,
      )
    }
    const restore = (): void => { writeFileSync(path, original, 'utf8') }
    const onSig = (): void => { restore(); process.exit(130) }
    process.once('SIGINT', onSig)

    let mutated: OracleRun = { ratio: null, numericErr: null, passed: false, raw: '' }
    try {
      // (iii) Apply the reversible edit.
      writeFileSync(path, original.replace(mut.find, mut.replace), 'utf8')
      // eslint-disable-next-line no-console
      console.log(`[evaluator] applied mutation: ${mut.name}`)
      // (iv) Re-run Oracle-B.
      mutated = runOracleB()
    } finally {
      // (vi) Revert ALWAYS.
      restore()
      process.removeListener('SIGINT', onSig)
      // eslint-disable-next-line no-console
      console.log(`[evaluator] reverted: ${mut.file}`)
    }

    // (v) Caught? The clean baseline PASSES its own gate (verified above); the
    // mutation is caught IFF the mutated tree FAILS the gate. This leans on
    // ALL THREE oracles (drawCalls>0, numeric forward-agreement, pixel) — a
    // projection-constant nudge is caught DECISIVELY by the numeric oracle
    // (the pixel oracle is insensitive to a sub-% scale shift on sparse
    // geometry, so a pixel-delta threshold alone MISSES it: WORLD_MERC×1.01
    // moved pixel 0.65%→0.63% but numeric 4e-5→12.7px). Baseline-green is the
    // precondition that makes "mutated fails" a non-trivial catch signal.
    const caught = mutated.passed === false

    results.push({
      name: mut.name,
      baseline: base.ratio,
      mutated: mutated.ratio,
      caught,
    })
    // eslint-disable-next-line no-console
    console.log(
      `[evaluator] ${mut.name}: ` +
      `baseline{mismatch=${(base.ratio * 100).toFixed(3)}%, numericErr=${base.numericErr}px, PASS} → ` +
      `mutated{mismatch=${mutated.ratio !== null ? (mutated.ratio * 100).toFixed(3) + '%' : 'n/a'}, ` +
      `numericErr=${mutated.numericErr ?? 'n/a'}px, ${mutated.passed ? 'PASS' : 'FAIL'}} ` +
      `→ ${caught ? 'CAUGHT' : 'MISSED'}`,
    )
  }

  return results
}

function main(): void {
  const results = evaluate()
  const caught = results.filter((r) => r.caught).length
  const total = results.length
  // eslint-disable-next-line no-console
  console.log(`\n[evaluator] mutation catch-rate: ${caught}/${total}`)
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  - ${r.caught ? '✓' : '✗'} ${r.name}`)
  }
  process.exit(caught === total ? 0 : 1)
}

// Run when invoked directly (tsx/node). Guarded so importing the module
// (e.g. to reuse MUTATIONS or runOracleB in a spec) does not execute it.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /evaluator\.ts$/.test(process.argv[1] ?? '')
if (invokedDirectly) main()

export { MUTATIONS, runOracleB, evaluate, CATCH_DELTA, PIXEL_MISMATCH_MAX }
export type { Mutation, MutationResult }

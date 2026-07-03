#!/usr/bin/env bun
// Fast local pre-push gate. Runs the vitest suite the CI `test` job
// runs, plus optionally the smoke playwright spec, with clear timing
// so you know what you're paying.
//
// Default (`bun precheck`): vitest only. ~30-60 s on a typical dev box.
//   Mirrors the CI `test` job — catches logic regressions (camera math,
//   slice-key invariants, filter routing) before CI does.
//
// Smoke (`bun precheck:smoke`): adds the projection-coverage Playwright
//   spec. ~2-3 min total. Overlaps the CI `render-gate` job (test.yml),
//   which runs projection-coverage + shader-math-parity under SwiftShader
//   so GPU-independent projection / shader-math regressions surface in CI;
//   the pixel survey stays local (SwiftShader can't raster the pipeline).
//
// Wired as a git pre-push hook by `bun setup:hooks` — once armed,
// every `git push` runs the default tier. Skip with `git push --no-verify`.
//
// Why TS+bun (vs bash): one entry, works on Windows PowerShell and macOS
// without shell variant headaches; matches the repo's Bun-everywhere
// convention.

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const args = new Set(process.argv.slice(2))
const RUN_SMOKE = args.has('--smoke')
// The visual-regression MATRIX gate (real-GPU, LOCAL only). Opt-in: it is NOT
// in the default push path, so `git push` stays vitest-only (~1 min). Run it
// explicitly via `bun precheck:matrix` or by exporting XGIS_MATRIX=1.
const RUN_MATRIX = args.has('--matrix') || process.env.XGIS_MATRIX === '1'

type Step = {
  label: string
  cmd: string
  args: string[]
  cwd?: string
  // Extra env vars merged over process.env for this step (e.g. XGIS_MATRIX=1
  // to lift the matrix gate's opt-in test.skip).
  env?: Record<string, string>
  // Treats `1 error / N failed` (vitest worker-IPC timeout flake) as
  // success when the test-failure count is zero. Vitest's "Unhandled
  // Errors" bucket fires on long-running suites due to worker rpc
  // teardown races (`Timeout calling "onTaskUpdate"`); it doesn't
  // reflect a test outcome. Without this gate, every precheck run
  // would false-fail.
  parseTestOutcomeFromStdout?: boolean
}

const steps: Step[] = [
  {
    label: 'vitest (unit)',
    cmd: 'bun',
    args: ['x', 'vitest', 'run', 'compiler/src', 'blueprint/src', 'runtime/src'],
    parseTestOutcomeFromStdout: true,
  },
]

if (RUN_SMOKE) {
  steps.push({
    label: 'playwright projection-coverage (smoke)',
    cmd: 'bun',
    args: [
      'x',
      'playwright',
      'test',
      'e2e/_projection-coverage.spec.ts',
      '--workers=3',
      '--reporter=line',
    ],
    cwd: 'playground',
  })
}

if (RUN_MATRIX) {
  // Vite-cache gotcha (load-bearing): the pre-bundled @xgis/runtime workspace
  // dep in node_modules/.vite masks runtime/src edits, so a stale cache would
  // gate against OLD code. Clear it before the run (same fix as evaluator.ts).
  try {
    rmSync('playground/node_modules/.vite', { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  steps.push({
    label: 'playwright matrix-gate (real-GPU, LOCAL)',
    cmd: 'bun',
    // serial (GPU contention) + XGIS_MATRIX=1 (via `env` below) so the opt-in
    // test.skip lifts. NO XGIS_SOFTWARE_GPU → inherits HEADED real GPU.
    args: ['x', 'playwright', 'test', 'e2e/_matrix-gate.spec.ts', '--workers=1', '--reporter=line'],
    cwd: 'playground',
    env: { XGIS_MATRIX: '1' },
  })
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(0)
  return `${m}m ${s}s`
}

let totalMs = 0
let failed = false

for (const step of steps) {
  const t0 = Date.now()
  console.log(`\n→ ${step.label}`)
  const useStdoutGate = step.parseTestOutcomeFromStdout === true
  // pipe stdout when we need to parse it; inherit otherwise. tee back
  // to the terminal so the user still sees live progress.
  const stepEnv = step.env ? { ...process.env, ...step.env } : process.env
  const result = useStdoutGate
    ? spawnSync(step.cmd, step.args, {
        cwd: step.cwd,
        env: stepEnv,
        shell: process.platform === 'win32',
        encoding: 'utf8',
      })
    : spawnSync(step.cmd, step.args, {
        stdio: 'inherit',
        env: stepEnv,
        cwd: step.cwd,
        shell: process.platform === 'win32',
      })
  const ms = Date.now() - t0
  totalMs += ms

  let ok = result.status === 0
  if (useStdoutGate) {
    // Stream the captured output so the dev sees it.
    if ('stdout' in result && typeof result.stdout === 'string') process.stdout.write(result.stdout)
    if ('stderr' in result && typeof result.stderr === 'string') process.stderr.write(result.stderr)
    // Override-on-pass: if vitest exited non-zero but reported "0 failed",
    // the failure is the worker-IPC flake, not a real regression.
    if (!ok) {
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const m = /Tests\s+\S*\s*(\d+)\s+failed/.exec(combined)
      const noTestFailures = !m && /Tests\s+[^\n]*passed/.test(combined)
      if (m && Number(m[1]) === 0) ok = true
      else if (noTestFailures && /Unhandled Error/.test(combined)) ok = true
    }
  }

  console.log(`${ok ? '✓' : '✗'} ${step.label} (${fmt(ms)})`)
  if (!ok) {
    failed = true
    break
  }
}

console.log(`\n${failed ? '✗ precheck FAILED' : '✓ precheck PASSED'} (${fmt(totalMs)})`)
process.exit(failed ? 1 : 0)

#!/usr/bin/env bun
// Local pre-push gate. Runs the vitest suite the CI `test` job runs,
// plus optionally the smoke playwright spec, with clear timing so you
// know what you're paying.
//
// Default (`bun precheck`): the FULL vitest suite (no path filter), ~2m20s
//   on a 4-core box — it runs through scripts/vitest-run.ts, which splits the
//   same 1411 files into a shared-registry pass and an isolation quarantine
//   (7m26s before that split). It intentionally runs everything the CI test
//   matrix shards across (compiler-blueprint / shader-dsl-a+b / map-a..e /
//   data / engine-rhi-shared) — the root vitest.config include is the single
//   authority, so this local gate can never lose a leg the CI matrix has.
//   A prior partial mirror (compiler/blueprint/runtime only) let two PRs
//   in one day pass precheck locally and then fail CI's `test (map)` leg
//   (backend-adapter / backend-identity ratchets); partial mirroring was
//   dropped for that reason.
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
}

const steps: Step[] = [
  {
    // The CI `lint` job runs the same command; ~0.5 s here, so it goes first and a
    // pasted block fails the push before the ~2 min vitest pass starts.
    label: 'duplication ratchet (jscpd)',
    cmd: 'bun',
    args: ['scripts/dup-ratchet.ts'],
  },
  {
    label: 'vitest (unit)',
    cmd: 'bun',
    // scripts/vitest-run.ts, NOT bare vitest: it runs the suite as two passes
    // (shared module registry + the isolation quarantine) over the SAME
    // vitest.config.ts include list, which is 7m26s → 2m20s on a 4-core box for
    // the identical 1411 files. It also owns the worker-IPC flake gate that used
    // to live here, hence no `parseTestOutcomeFromStdout` below.
    args: ['scripts/vitest-run.ts'],
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
  // Vite-cache gotcha (load-bearing): the pre-bundled @xgis/map workspace
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

// Files under a path the unit suite actually exercises — the SAME set the CI
// `changes` job uses to decide whether to run the `test` matrix (test.yml). If
// a push touches none of these, the vitest run below can't regress and CI won't
// run it either, so we skip it locally too. Keep in sync with test.yml's `code`
// filter.
const CODE_PATH =
  /^(compiler|engine|map|shared|geo|blueprint|shader-dsl|rhi|rhi-webgl2|rhi-webgpu|data|pipeline|playground)\/|(^|\/)package\.json$|^bun\.lockb?$|^tsconfig.*\.json$|^vitest\.(config|setup)\.ts$|^\.github\/workflows\/test\.yml$|^scripts\/precheck\.ts$|^scripts\/dup-ratchet\.ts$|^\.jscpd(-baseline)?\.json$/

/**
 * The files this push would add, or `null` if the range can't be determined
 * (→ caller runs the suite, conservatively). The range is HEAD since its
 * merge-base with the upstream tracking branch; for a branch with no upstream
 * yet, it falls back to the merge-base with origin/main.
 */
function pushChangedFiles(): string[] | null {
  const git = (a: string[]) => spawnSync('git', a, { encoding: 'utf8' })
  let base = ''
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (up.status === 0 && up.stdout.trim()) {
    base = up.stdout.trim()
  } else {
    for (const ref of ['origin/main', 'origin/HEAD']) {
      const mb = git(['merge-base', 'HEAD', ref])
      if (mb.status === 0 && mb.stdout.trim()) {
        base = mb.stdout.trim()
        break
      }
    }
  }
  if (!base) return null
  const diff = git(['diff', '--name-only', `${base}...HEAD`])
  if (diff.status !== 0) return null
  return diff.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Path-relevance gate (default push path only — an explicit --smoke/--matrix or
// PRECHECK_FORCE=1 always runs). A docs/site/diagrams-only push shares nothing
// with the unit suite, and CI skips the test matrix for it too, so don't tax it
// ~minutes of vitest. Skip with `git push --no-verify` to bypass the whole hook.
if (!RUN_SMOKE && !RUN_MATRIX && process.env.PRECHECK_FORCE !== '1') {
  const changed = pushChangedFiles()
  if (changed !== null && changed.length > 0 && !changed.some((f) => CODE_PATH.test(f))) {
    console.log(
      `\n✓ precheck SKIPPED — ${changed.length} changed file(s), none under a tested code ` +
        `path.\n  (compiler/engine/map/shared/geo/blueprint/shader-dsl/rhi/data/pipeline/` +
        `playground or a build/config file.)\n  Force with \`PRECHECK_FORCE=1 bun run precheck\`.`,
    )
    process.exit(0)
  }
}

let totalMs = 0
let failed = false

for (const step of steps) {
  const t0 = Date.now()
  console.log(`\n→ ${step.label}`)
  const stepEnv = step.env ? { ...process.env, ...step.env } : process.env
  const result = spawnSync(step.cmd, step.args, {
    stdio: 'inherit',
    env: stepEnv,
    cwd: step.cwd,
    shell: process.platform === 'win32',
  })
  const ms = Date.now() - t0
  totalMs += ms

  const ok = result.status === 0

  console.log(`${ok ? '✓' : '✗'} ${step.label} (${fmt(ms)})`)
  if (!ok) {
    failed = true
    break
  }
}

console.log(`\n${failed ? '✗ precheck FAILED' : '✓ precheck PASSED'} (${fmt(totalMs)})`)
process.exit(failed ? 1 : 0)

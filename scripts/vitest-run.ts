#!/usr/bin/env bun
// The local entry point for the unit suite: `bun run test`, and the vitest step
// of `bun precheck`.
//
// It runs vitest TWICE over one config (vitest.config.ts, which documents the
// split in full):
//
//   XGIS_VITEST_MODE=shared    every file except ISOLATED, one module registry
//                              per worker instead of one per file
//   XGIS_VITEST_MODE=isolated  exactly ISOLATED, vitest's default per-file
//                              isolation — the files whose subject IS a registry
//                              (`vi.mock`) or a pristine process global
//
// The two `include` sets are complements carved from the same list, so the union
// is the suite: nothing can fall out by being forgotten in one half. MEASURED on
// this tree (4-core container, 1411 files / 12230 tests): 7m26s as one isolated
// run, 2m20s as these two passes (1306 shared in ~1m32s + 105 isolated in ~47s,
// three consecutive runs at 2m20 / 2m18 / 2m21). The saving is not test time —
// that is ~265s either way — it is the per-file cost of re-entering the module
// graph (setup 238s → 4s, collect 429s → 74s, prepare 107s → 0.8s).
//
// Every argument is forwarded to BOTH passes, so `bun run test map/src` and
// `bun run test -t 'some name'` work as they do with bare vitest. A filter that
// selects files from only one half leaves the other with nothing to run, hence
// `--passWithNoTests` on both — an empty half is the normal case here, not an
// error. (`bun run test --watch` is NOT this script's job: use `vitest` directly,
// which still runs the whole suite under the old isolated semantics.)

import { spawn } from 'node:child_process'

const forwarded = process.argv.slice(2)

type Pass = { mode: 'shared' | 'isolated'; label: string }
const PASSES: Pass[] = [
  { mode: 'shared', label: 'vitest (shared registry)' },
  { mode: 'isolated', label: 'vitest (isolated)' },
]

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${(((ms % 60_000) / 1000) | 0).toString()}s`
}

/**
 * Treats `1 error / 0 failed` as success. Vitest's "Unhandled Errors" bucket
 * fires on long-running suites through a worker->main rpc teardown race
 * (`Timeout calling "onTaskUpdate"`); it does not reflect a test outcome, and
 * without this gate a full run would false-fail. Lifted verbatim from
 * precheck.ts, which used to own it when it spawned vitest itself.
 */
function outcomeFromStdout(combined: string): boolean {
  const m = /Tests\s+\S*\s*(\d+)\s+failed/.exec(combined)
  if (m) return Number(m[1]) === 0
  return /Tests\s+[^\n]*passed/.test(combined) && /Unhandled Error/.test(combined)
}

function runPass(pass: Pass): Promise<{ ok: boolean; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    console.log(`\n→ ${pass.label}`)
    const child = spawn('./node_modules/.bin/vitest', ['run', '--passWithNoTests', ...forwarded], {
      env: { ...process.env, XGIS_VITEST_MODE: pass.mode },
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    // Streamed, not buffered-then-dumped: a 2-minute pass with no output looks
    // wedged. The copy is only kept so the flake gate above has something to read.
    let seen = ''
    child.stdout?.on('data', (c: Buffer) => {
      seen += c
      process.stdout.write(c)
    })
    child.stderr?.on('data', (c: Buffer) => {
      seen += c
      process.stderr.write(c)
    })
    child.on('close', (code) => {
      const ok = code === 0 || outcomeFromStdout(seen)
      const ms = Date.now() - t0
      console.log(`${ok ? '✓' : '✗'} ${pass.label} (${fmt(ms)})`)
      resolve({ ok, ms })
    })
  })
}

let failed = false
let totalMs = 0
// Both passes always run, even after a failure: the isolated half is ~47s and a
// developer who has just broken something wants the whole picture, not the first
// half of it.
for (const pass of PASSES) {
  const { ok, ms } = await runPass(pass)
  totalMs += ms
  if (!ok) failed = true
}

console.log(`\n${failed ? '✗ unit suite FAILED' : '✓ unit suite PASSED'} (${fmt(totalMs)})`)
process.exit(failed ? 1 : 0)

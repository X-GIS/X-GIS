// ═══ The local unit gate's exit code is a PREDICATE, and it was lying green (#2265) ═══
//
// `vitest-run.ts` overrides vitest's exit code when `outcomeFromStdout` says the only thing
// wrong was the worker->main RPC teardown race. That override is the whole reason
// `bun run test` can report a verdict at all on a combined run — and until this file it had
// no test, so the predicate's SHAPE was never checked against anything.
//
// It was too broad: it accepted vitest's `Unhandled Errors` BANNER, which is printed for
// every entry in that bucket, when the thing it meant to accept is one message inside it.
// An all-passing run whose bucket held a real unhandled rejection was reported PASSED.
//
// ─── The fixtures are the strings vitest ACTUALLY emits, not plausible ones ───
// This is the trap the first draft of this work fell into: a fixture was written from memory
// as `Vitest caught 1 error during the test run`, and the real banner says `unhandled` in the
// middle of it. A predicate tested against invented output proves nothing about the real
// output, which is the same failure class this file exists to gate. Every literal below is
// quoted from `vitest@3.2.6`:
//
//   `[vitest-worker]: Timeout calling "${functionName}"`   chunks/rpc.*.js   onTimeoutError
//   `Vitest caught ${errors.length} unhandled error${…}`   chunks/cli-api.*.js
//
// If a vitest upgrade changes either, arm (A) goes red — which is the correct outcome, since
// the predicate would then be suppressing nothing and the override would be dead code.

import { describe, it, expect } from 'vitest'
import { outcomeFromStdout } from './vitest-run'

/** Vitest's all-passed summary line, with no `failed` segment — the shape that makes the
 *  banner arm decide at all. Branch 1 only runs when a `N failed` token is present. */
const ALL_PASSED = 'Tests  13140 passed | 7 skipped (13147)'

const BANNER = 'Unhandled Errors\n\nVitest caught 1 unhandled error during the test run.'

describe('outcomeFromStdout — the local gate’s exit-code override (#2265)', () => {
  it('A. suppresses the worker RPC teardown race, which is what the override is for', () => {
    expect(
      outcomeFromStdout(
        `${ALL_PASSED}\n\n${BANNER}\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\n`,
      ),
    ).toBe(true)
  })

  it('B. does NOT suppress a real unhandled error just because the banner is present', () => {
    // The regression. Every test passed and vitest still exited 1, for a reason that is not
    // the RPC race; reporting PASSED here is the local gate telling the developer a red tree
    // is green. CI is unaffected (it runs vitest directly and shards, test.yml:277-287),
    // which is exactly why this went unnoticed.
    expect(
      outcomeFromStdout(`${ALL_PASSED}\n\n${BANNER}\nError: connect ECONNREFUSED 127.0.0.1:5432\n`),
      'a non-RPC unhandled error must NOT be laundered into success',
    ).toBe(false)
  })

  it('C. a genuine test failure decides on the count, never on the banner', () => {
    // Also the non-vacuity control for A and B: a predicate that returned true for
    // everything would satisfy A, and one that returned false for everything would satisfy
    // B. Only a predicate that DISTINGUISHES satisfies all three.
    expect(outcomeFromStdout('Tests  3 failed | 13137 passed (13140)')).toBe(false)
    expect(outcomeFromStdout('Tests  0 failed | 13140 passed (13140)')).toBe(true)
  })

  it('D. a clean run with no bucket at all is decided by the exit code, not by this', () => {
    // `runPass` reads `code === 0 || outcomeFromStdout(seen)`, so `false` here is correct
    // and inert: a clean run already exited 0. It is asserted so that a future widening
    // cannot make the override fire on output it was never meant to see.
    expect(outcomeFromStdout(ALL_PASSED)).toBe(false)
  })

  it('E. a crash before any summary is never suppressed', () => {
    expect(outcomeFromStdout('FATAL: worker died\n')).toBe(false)
    expect(outcomeFromStdout('')).toBe(false)
  })

  it('the module is importable without running the suite (import.meta.main guard)', () => {
    // Reaching this line at all is the assertion: the import at the top of this file would
    // otherwise spawn both vitest passes from inside a vitest worker. The guard is the same
    // idiom seven other scripts/ entry points use.
    expect(typeof outcomeFromStdout).toBe('function')
  })
})

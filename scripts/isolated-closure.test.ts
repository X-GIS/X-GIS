// ═══ A `vi.mock` file missing from ISOLATED reports GREEN until the pool repacks (#1958) ═══
//
// `vitest.config.ts` splits the unit suite in two: `ISOLATED` keeps one module registry
// per file, everything else shares one per worker. Its rule (1) is stated there as a
// CLASS, not a list of casualties:
//
//   > `vi\.mock\(|vi\.doMock\(` — module mocking is a statement ABOUT a registry, so it
//   > needs one it owns.
//
// and the same comment says exactly what happens when the class is under-applied:
//
//   > admitting only the observed casualties leaves the rest to fail at random on some
//   > later run — and a gate that is red at random trains people to ignore it.
//
// Nothing enforced it. `map/src/map-inline-geojson-route.test.ts` mocks `@xgis/data`
// (#1837/#1940) and was the only one of 20 such files never listed. It stayed green for
// as long as the worker pool happened to schedule it ahead of every sibling that imports
// the real `@xgis/data` — and came due when an UNRELATED shader-dsl spec grew by two
// cases (#1903/#1957), repacked the workers, and reddened six assertions in a file that
// PR had never touched. Attribution took a stash-and-rerun to establish.
//
// So this gate closes rule (1): every file in the unit corpus that mocks a module must
// resolve into `ISOLATED`.
//
// ─── SCOPE: rules (1) and (2). (3) and (4) stay by-hand ───
// This gate covered rule (1) only until #2567, on the stated ground that "a regex
// pretending to check [rules 2-4] would be an assertion that carries no information".
// That is still true of (3) and (4) and they are still declined: "asserts a WALL-CLOCK
// threshold" and "the package whose suites drive a process-wide singleton" are judgements,
// and a regex for either would be a rubber stamp.
//
// Rule (2) is not like them, and #2567 is what made the difference concrete. Its triggers
// are a CLOSED, ENUMERATED list that `vitest.config.ts` writes down itself — the stub-global
// call, an assignment onto the process global, and four named authorities. Checking a list
// the rule already spells out is not a heuristic standing in for a judgement.
//
// What #2567 cost while this stayed open: the fourth `event-dispatcher-*` suite stubs the
// same animation-frame pair as the three listed beside it, was never added, and timed out at
// 30 s per test on 3 of 3 full sweeps while passing alone in 9 ms. Exactly rule (1)'s failure
// shape, one rule over.
//
// TWO false-positive classes had to be handled, and both were MEASURED on this corpus rather
// than guessed. Over 85 raw matches, NINE are prose — a file naming a trigger in a comment
// that explains why it does not call it — which `stripComments` below already removes, the
// same trap rule (1)'s header documents. The tenth is subtler and is why the assignment arm
// excludes `>`: a TYPE POSITION reads exactly like a write when the annotated value is an
// arrow function, and `map/src/sprite/sprite-idle-keep-warm.test.ts` has one. Left in, the
// gate would have demanded isolation for a file that writes nothing.
//
// ─── Why here, and why not somewhere cheaper ───
// NOT inside `vitest.config.ts`: the config module is evaluated on EVERY vitest
// invocation, twice per `bun run test` (shared + isolated), so a ~1400-file corpus walk
// there would be charged to every run forever. As a test it costs milliseconds, once.
//
// The corpus and the quarantine are IMPORTED from `vitest.config.ts`, never re-derived.
// Re-globbing the packages here would make this file a second authority on what the suite
// covers, which is the drift `vitest.config.ts`'s own "single authority" comment exists to
// prevent — and which CLAUDE.md §12 records dying silently twice.
//
// ─── Checked against the existing gates first (§12's second-ratchet lesson) ───
// `vitest.config.ts`'s own `barren` guard owns the OPPOSITE direction (every ISOLATED
// entry still resolves to a file) and cannot see a file that should be listed and is not.
// `workflow-validity` / `render-shard-coverage` / `paths-filter-semantics` /
// `post-merge-guard` all gate `.github/workflows/test.yml` and never read this config.
// No existing gate owns this invariant.

import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INCLUDE, ISOLATED } from '../vitest.config'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The literal call, matching the rule as `vitest.config.ts` states it so the two cannot
 *  drift apart in wording. */
const MOCK_CALL = /\bvi\s*\.\s*(?:mock|doMock)\s*\(/

/** Rule (2)'s triggers, matching the rule as `vitest.config.ts` states it so the two cannot
 *  drift apart in wording: the stub-global call, an assignment onto the process global, a
 *  `vi.spyOn` on the process global or on a global CLOCK, and the four authorities that keep
 *  their state there.
 *
 *  `[^=>]` after the assignment is load-bearing, not tidiness — see the header: it keeps a
 *  type annotation on an arrow-returning value from reading as a write.
 *
 *  The `spyOn` arm is load-bearing for the same reason one level over, and it is what the
 *  `>` exclusion alone got WRONG. `vi.spyOn(performance, 'now')` replaces a method on an
 *  object every module in the worker shares — the same write as `stubGlobal`, one level
 *  down — and the arms beside it cannot see it. `map/src/sprite/sprite-idle-keep-warm.test.ts`
 *  is the measured casualty: it holds a genuine type-position match at line 110 AND three
 *  real `vi.spyOn(performance, 'now')` writes, so clearing it on the strength of the former
 *  cleared a true positive. 30 s timeout in the shared pass on a full sweep, 16 ms alone.
 *
 *  The receiver list is CLOSED on purpose. `globalThis`, `performance` and `Date` are read
 *  BACK by other modules — a frozen clock changes what a deadline comparison in a different
 *  file evaluates to. `console` is not: it is a sink nothing reads, so the 22 files that spy
 *  only on it are deliberately out (#2634 carries the list and the reasoning, so the day a
 *  swallowed-warning failure appears the judgement that excluded them is on record). */
const GLOBAL_WRITE =
  /\bvi\s*\.\s*stubGlobal\s*\(|\bglobalThis\s*\.\s*\w+\s*=[^=>]|\bvi\s*\.\s*spyOn\s*\(\s*(?:globalThis|performance|Date)\s*,|\b(?:configureBody|configureBodyConsts|configureProjections|setLogSink)\s*\(/

/** Comments stripped before matching, because the rule is about what a file CALLS.
 *
 *  This is worth more than it looks. A RAW grep for the call over this corpus returns 25
 *  files; only 20 of them call it. The other five merely NAME it in a header explaining
 *  why they deliberately do NOT use it — `map/src/source-manager-drop-tiling.test.ts`
 *  says "a hoisted vi.mock('@xgis/data') could bind [too late], so a module-mock would
 *  miss; vi.spyOn ..." — and a gate keyed on the raw grep would quarantine all five for
 *  a call they never make. The first survey of this problem used that raw count and
 *  reported 25; the number in the header above is the measured one.
 *  Not pedantry: this gate's own header quotes the rule verbatim, so the very first run
 *  flagged THIS file — and the only honest repairs were to quarantine a file that mocks
 *  nothing, or to stop matching prose. Any doc that names the call would have hit the
 *  same wall. Crude by design (a `/*` inside a string can mis-strip); the output feeds a
 *  boolean, never a parse. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Expand a glob list against the repo root into a set of repo-relative paths. */
const expand = (patterns: readonly string[]): Set<string> => {
  const out = new Set<string>()
  for (const p of patterns) {
    for (const f of globSync(p, { cwd: ROOT })) out.add(relative(ROOT, join(ROOT, f)))
  }
  return out
}

describe('vitest.config.ts ISOLATED — rule (1) + (2) closure (#1958, #2567)', () => {
  const corpus = expand(INCLUDE)
  const quarantined = expand(ISOLATED)

  it('the corpus and the quarantine both resolve — otherwise everything below is vacuous', () => {
    // Without this, a glob change that resolved to nothing would make the real assertion
    // pass over an empty set and report closure it never checked.
    expect(corpus.size).toBeGreaterThan(1000)
    expect(quarantined.size).toBeGreaterThan(50)
    // Every quarantined file is part of the corpus: a quarantine entry outside what the
    // suite runs would quietly exclude nothing in `shared` mode.
    const stray = [...quarantined].filter((f) => !corpus.has(f)).sort()
    expect(stray, `ISOLATED entries outside the INCLUDE corpus:\n${stray.join('\n')}`).toEqual([])
  })

  it('every file that writes a process global is quarantined', () => {
    const writers = [...corpus]
      .filter((f) => GLOBAL_WRITE.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))))
      .sort()

    // Non-vacuity, same shape as rule (1)'s: a scan that found nothing would let the
    // assertion below pass over an empty set. A floor, not a pin.
    expect(writers.length).toBeGreaterThan(40)

    const missing = writers.filter((f) => !quarantined.has(f))
    expect(
      missing,
      `${missing.length} file(s) write a process global but are not in ISOLATED.\n` +
        `One registry per worker means the write outlives the file: a sibling packed into\n` +
        `the same worker sees the stub, or the file's own stub loses to a module the\n` +
        `sibling already imported. It passes until the pool repacks, then hangs or reddens\n` +
        `somewhere unrelated — #2567 was 30 s timeouts whose VICTIM MOVED between runs.\n\n` +
        `Paste into the ISOLATED list in vitest.config.ts, with the reason:\n` +
        missing
          .map((f) => `  // (2) process-global write — <which one, and why>\n  '${f}',`)
          .join('\n'),
    ).toEqual([])
  })

  it('every file that mocks a module is quarantined', () => {
    const mockers = [...corpus]
      .filter((f) => MOCK_CALL.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))))
      .sort()

    // Non-vacuity, the near half: if the scan found nothing, the assertion below would
    // pass while checking no file at all. The count is a floor, not a pin — new mocking
    // files are expected and only need to join ISOLATED.
    expect(mockers.length).toBeGreaterThan(10)

    const missing = mockers.filter((f) => !quarantined.has(f))
    expect(
      missing,
      `${missing.length} file(s) call the vitest module-mock API but are not in ISOLATED.\n` +
        `A shared module registry is exactly what a mocking file must NOT have: when a\n` +
        `sibling in the same worker imported the real module first, the mock does not\n` +
        `take. It passes until the pool repacks, then reddens somewhere unrelated.\n\n` +
        `Paste into the ISOLATED list in vitest.config.ts, with the reason:\n` +
        missing.map((f) => `  // (1) module mock — <what it mocks, and why>\n  '${f}',`).join('\n'),
    ).toEqual([])
  })
})

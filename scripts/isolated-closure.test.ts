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
// ─── SCOPE: rule (1) ONLY, and that is deliberate ───
// Rules (2)-(4) are not cheaply mechanical — a process-global write, a wall-clock
// threshold, "the whole @xgis/rhi-webgpu package" — and a regex pretending to check them
// would be an assertion that carries no information. They stay by-hand. This gate is
// narrow on purpose; do not read its green as covering the other three.
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

describe('vitest.config.ts ISOLATED — rule (1) closure (#1958)', () => {
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

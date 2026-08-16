// ═══ Every e2e spec must LOAD (#1638) ═══
//
// `bun run test:e2e` collected `0 tests in 0 files` for an unknown length of
// time. Six specs threw at module scope, and a module-scope throw is a
// COLLECTION error — Playwright aborts the entire run rather than the one
// file, so six rotted specs silently took 379 healthy ones with them.
// `--grep-invert` does not rescue it either: filtering happens after module
// load.
//
// CI never noticed because `.github/workflows/test.yml` names its render-gate
// specs EXPLICITLY, so it only ever loads the ~49 it lists. The failure was
// visible only to a human running the documented whole-suite command.
//
// WHY THIS ASSERTS LOADING AND NOT A LINT RULE. The three root causes were an
// untracked baseline read at module scope, a stale relative import, and a
// workspace-package import that the Playwright loader cannot resolve. A static
// rule catches the first two; the third is indistinguishable from the package
// imports that DO work (`_vs-clip-parity` imports `@xgis/compiler` and is green
// in CI), so no syntactic rule separates them. Actually loading every module is
// the only check that covers all three — and `--list` does exactly that for
// 5 s, with no browser and no dev server.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAYGROUND = resolve(HERE, '..')
const E2E_DIR = join(PLAYGROUND, 'e2e')

/** Spec files on disk — the population `--list` must be able to load. */
const specFiles = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))

describe('every e2e spec loads — a module-scope throw aborts the whole suite (#1638)', () => {
  it('the corpus is nonempty', () => {
    // A gate that does not prove its own population is the bug it guards
    // against, one level up (#1625).
    expect(specFiles.length, `no .spec.ts files under ${E2E_DIR}`).toBeGreaterThan(300)
  })

  it('`playwright test --list` collects every spec file, with no collection errors', () => {
    let stdout: string
    try {
      stdout = execFileSync('./node_modules/.bin/playwright', ['test', '--list'], {
        cwd: PLAYGROUND,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string }
      throw new Error(
        `playwright could not collect the e2e suite — one or more specs throw at module ` +
          `scope, which aborts the run for ALL of them (#1638). Fix the erroring spec; a ` +
          `module-scope readFileSync of an untracked path, a stale relative import, and a ` +
          `workspace-package import the loader cannot resolve have each caused this.\n\n` +
          `${err.stderr ?? ''}\n${err.stdout ?? err.message}`.slice(0, 4000),
      )
    }

    const match = /Total:\s+(\d+)\s+tests? in\s+(\d+)\s+files?/.exec(stdout)
    expect(
      match,
      `could not parse a "Total:" line from --list output:\n${stdout.slice(-2000)}`,
    ).not.toBeNull()

    const filesCollected = Number(match![2])
    // Exact equality would break on any spec that legitimately generates no
    // test (none today); the floor that matters is "essentially all of them",
    // which still goes red the moment one spec's throw drops the count to 0.
    expect(
      filesCollected,
      `--list collected ${filesCollected} of ${specFiles.length} spec files — a spec that ` +
        `fails to load takes the whole suite with it (#1638)`,
    ).toBeGreaterThanOrEqual(specFiles.length)
  })
})

// ═══ A spec NAMED a gate must be RUN by CI, or listed here as knowingly dark (#1715) ═══
//
// The file above proves every spec LOADS. That is orthogonal to whether anything runs it:
// test.yml names its render-gate specs explicitly, so a spec absent from that list is green
// forever by never executing. #1719 found two shader-dsl gates in exactly that state — they
// had never run once — and registering them was the whole fix.
//
// A sweep for the rest found 34 more, out of 81 files whose NAME claims they are gates. 30 of
// them turned out to PASS on headless WebGL2 — twice, in two independent runs — and are now
// registered in test.yml. Confirming twice was not ceremony: `_matrix-gate` passed alone and
// failed inside a 19-way batch, so a single green would have shipped a flake into a shared
// leg. Three then came off the list the honest way: `_1235-measure-gate`, whose defect was
// FIXED (#1728 — a re-seed could not recover a source whose GPU tiles had all dropped);
// `_world-copies-projection-gate`, whose row turned out to be diagnosing the wrong thing
// (#1730); and `_gl2-live-swap-gate`, whose second failure magnitude was finally EXPLAINED
// (#1715 — the same adaptive ladder as the first, walked to its `{ farLod: 6, dpr: 0.5 }`
// floor; `?adaptive=0` covers it, proven by A/B under a saturated CPU). The one below is
// what is left, with the reason it is still dark.
//
// The cost is recorded because it is the argument for splitting the leg later: the 30 add a
// measured ~14 min to render-gate's SwiftShader step, which was 20.7 min for 63 specs. A
// matrix split is one edit away, but it renames the check to `render-gate (a)` and this repo's
// branch protection is not visible from the code — so that decision needs someone who can see
// the settings, not a guess.
//
// SHRINK-ONLY, in both directions:
//   • a gate-named spec missing from CI and from this list  → red, add it to CI or here
//   • a row here that IS now registered                     → red, delete the row
//   • a row here naming a file that no longer exists        → red, delete the row
//
// The middle rule is the ratchet: registering one of these costs a one-line deletion, and the
// count below stays true instead of drifting into folklore (the path-keyed-gate failure in
// CLAUDE.md §12 — two gates sat vacuously green for a release because their keys had moved).
//
// Specs NOT covered here: `_debug-*`, `_perf-*`, `_pixel-match-*` and friends. Of the 319
// unregistered specs, most are investigation and profiling probes that were never meant to
// gate anything; requiring those to run in CI would be wrong, not rigorous. The name is the
// contract — call a spec a gate and it has to be one.
const KNOWN_DARK_GATES: readonly string[] = [
  // OPT-IN AND LOCAL BY DESIGN — not a defect, and not pending anything. The row used to say
  // "FLAKY, green on its own, red inside a 19-way batch". The flakiness was real (measured
  // with XGIS_MATRIX=1), but it was never the reason this cannot be registered, and stating
  // it that way implied a fix was owed. Two things actually govern:
  //
  //   • `test.skip(!MATRIX_ON)` — CI does not set XGIS_MATRIX, so registering it would make
  //     EVERY cell skip. A registered spec that always skips is vacuously green, which is
  //     precisely the failure this whole list exists to prevent.
  //   • ADR-0004 — it is a real-GPU visual-regression matrix, and CI's SwiftShader cannot
  //     raster the pipeline. The spec's own header says so: "OPT-IN ONLY … CI (no GPU) never
  //     run it … Real GPU, LOCAL/pre-push only".
  //
  // It IS a gate, so the name is honest; it is just a PRE-PUSH gate (`bun precheck:matrix`),
  // a third category this list's CI-registered/dark split has no slot for. Listing it here
  // with this reason is the accurate answer, and there is no follow-up work behind it.
  '_matrix-gate.spec.ts',
]

describe('a gate-named spec is either run by CI or knowingly dark (#1715)', () => {
  const workflow = readFileSync(resolve(PLAYGROUND, '../.github/workflows/test.yml'), 'utf8')
  const registered = new Set(workflow.match(/_[a-z0-9-]+\.spec\.ts/g) ?? [])
  const gateNamed = specFiles.filter((f) => f.endsWith('-gate.spec.ts'))
  const dark = gateNamed.filter((f) => !registered.has(f))

  it('the readers found both populations — otherwise every arm below is vacuous', () => {
    expect(gateNamed.length, 'no *-gate.spec.ts found on disk').toBeGreaterThan(50)
    expect(registered.size, 'no spec names parsed out of test.yml').toBeGreaterThan(50)
  })

  it('no gate-named spec is dark without being listed', () => {
    const unlisted = dark.filter((f) => !KNOWN_DARK_GATES.includes(f))
    expect(
      unlisted,
      `these specs are named gates but no CI leg runs them:\n  ${unlisted.join('\n  ')}\n` +
        'Add them to the render-gate list in .github/workflows/test.yml, or to KNOWN_DARK_GATES ' +
        'with a reason — a gate nobody runs is not a gate.',
    ).toEqual([])
  })

  it('the list only shrinks — a row that got registered must be deleted', () => {
    const stale = KNOWN_DARK_GATES.filter((f) => registered.has(f))
    expect(stale, `now registered in CI, so delete these rows:\n  ${stale.join('\n  ')}`).toEqual(
      [],
    )
  })

  it('the list names no file that no longer exists', () => {
    // The failure CLAUDE.md §12 records: a path-keyed allowlist dies silently when files move.
    const missing = KNOWN_DARK_GATES.filter((f) => !specFiles.includes(f))
    expect(missing, `no such spec — delete these rows:\n  ${missing.join('\n  ')}`).toEqual([])
  })
})

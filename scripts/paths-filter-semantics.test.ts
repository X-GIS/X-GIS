// ═══ What test.yml's `changes` filter ACTUALLY matches — not what it looks like it matches ═══
//
// WHY THIS EXISTS. The `changes` job decides which of the engine legs run, and it is a
// PATH-KEYED allowlist evaluated by a third-party action. Both halves of that have already
// cost this repo real coverage: the two comments above the filter record `geo/**` and
// `rhi*/data/pipeline` each sitting CI-dark because no filter named them, and CLAUDE.md §12
// records the general shape — a path-keyed gate dies silently when the paths move. Nothing
// in the repo could tell the difference between a filter that fires and one that matches
// nothing, because a filter that matches nothing just skips jobs, and a skipped job reads as
// a pass through `test-result`.
//
// THE MEASUREMENT THAT MADE IT URGENT (#1842). `shader-dsl/CHANGELOG.md` matched
// `shader-dsl/**`, so the changelog regeneration PR — a diff of two generated files — fanned
// out the whole engine matrix plus `render-gate`, ≥26 min. Every merge to `main` force-pushes
// that PR's branch, `test.yml`'s `concurrency` cancels the in-flight run, and with a mean
// inter-merge interval near 22 min the run never finished: six cancellations, zero successes.
// The changelog could not land, and every workflow involved still reported success.
//
// THE FIX LOOKED LIKE ONE LINE AND WAS A TRAP. The obvious edit is to add
// `'!shader-dsl/CHANGELOG.md'` to `code`. Measured against the action's own matcher, that
// does the OPPOSITE of what it reads like:
//
//   pattern list                                  shader-dsl/CHANGELOG.md   map/src/render/x.ts
//   ['shader-dsl/**']                                    match                    .
//   ['shader-dsl/**', '!shader-dsl/CHANGELOG.md']        match                  match
//   ['shader-dsl/**/!(CHANGELOG.md)']                      .                      .
//
// The reason is in dorny/paths-filter's `src/filter.ts`: every entry of the YAML list becomes
// its OWN rule item, and the default `predicate-quantifier` is `some` — a file matches the
// filter if ANY rule matches it. picomatch compiles a leading-`!` pattern into a matcher that
// is true for everything the pattern excludes, so as a standalone rule it matches nearly every
// file in the repo. `code` would have become permanently true. The quantifier that would make
// a leading `!` mean exclusion, `some-with-excludes`, landed in v4.0.3; this repo pins `@v3`,
// whose newest release is v3.0.4 — it does not have it.
//
// So the filter uses an EXTGLOB instead. `!(CHANGELOG.md)` inside a pattern is an ordinary
// glob matching every basename it does not enumerate, which is a different mechanism from a
// leading `!` and needs no quantifier.
//
// WHAT THIS FILE ASSERTS, AND WHY IT IS NOT A STRING PIN. It rebuilds the matcher the way
// `createRuleItem` does — same picomatch, same `{dot: true}`, same one-rule-per-entry, same
// `some` — and runs the REAL filter block out of `test.yml` against representative paths. A
// test that only pinned the pattern text would pass identically whether the pattern works or
// is a typo matching nothing, which is the exact failure it exists to catch.
//
// NOT THE ONLY GATE ON THIS FILTER, and the other one is older. `map/src/architecture-
// invariants.test.ts` Gate-8 (#1565) asserts every package glob in `code` is in `render`
// too or exempt with a reason — a containment relation BETWEEN the two filters. This file
// asserts what each filter actually matches over the real tree. Different invariants, and
// both are needed: Gate-8 cannot see a pattern that matches nothing, and this file cannot
// see a package that is in `code` but missing from `render`.
//
// KEEPING IT HONEST WITH THE ACTION. `picomatch` is declared at `^2.3.1`, the range
// dorny/paths-filter declares for itself. If the action's pin moves, move this one with it —
// a gate that replicates a matcher is only as good as the matcher being the same one.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
import { parse } from 'yaml'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(REPO, '.github', 'workflows', 'test.yml')

/** Exactly `src/filter.ts`'s `MatchOptions`. */
const MATCH_OPTIONS = { dot: true }

interface FilterStep {
  readonly uses?: string
  readonly with?: { readonly filters?: string; readonly 'predicate-quantifier'?: string }
}

const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: { changes: { steps: readonly FilterStep[] } }
}

const filterStep = workflow.jobs.changes.steps.find((s) => (s.uses ?? '').includes('paths-filter'))

/** name → the pattern list, read out of the workflow rather than restated here. */
const FILTERS: Record<string, readonly string[]> = parse(filterStep?.with?.filters ?? '') as Record<
  string,
  readonly string[]
>

/** `createRuleItem` + the default `some` quantifier, together. Each list entry is its own rule
 *  (`parseFilterItemYaml` flattens the array into one rule per string), and `isMatch` reduces
 *  with `patterns.some(...)` unless a `predicate-quantifier` says otherwise — arm T3 pins that
 *  none does. */
function matcherFor(name: string): (file: string) => boolean {
  const rules = (FILTERS[name] ?? []).map((p) => picomatch(p, MATCH_OPTIONS))
  return (file) => rules.some((rule) => rule(file))
}

// ── T1: the reader read a filter at all ─────────────────────────────────────────────────
// First, and deliberately: every arm below is an assertion about `FILTERS`, so a reader that
// silently produced `{}` would make all of them vacuously true — a green gate over a filter
// it never saw.
describe('the filter block was actually read out of the workflow', () => {
  it('finds the paths-filter step and parses its three named filters', () => {
    expect(filterStep, `no dorny/paths-filter step in ${WORKFLOW}`).toBeDefined()
    expect(Object.keys(FILTERS).sort()).toEqual(['code', 'render', 'site'])
    for (const [name, patterns] of Object.entries(FILTERS)) {
      expect(patterns.length, `filter '${name}' parsed to an empty list`).toBeGreaterThan(0)
    }
  })

  it('every directory prefix the filters name still exists', () => {
    // The §12 lesson, applied to this allowlist: a path-keyed rule dies silently when the
    // path moves, and a filter naming a deleted package skips its jobs forever while looking
    // exactly like a filter with nothing to do.
    for (const [name, patterns] of Object.entries(FILTERS)) {
      for (const pattern of patterns) {
        const prefix = pattern.split('/')[0]
        if (prefix.includes('*') || prefix.includes('!') || prefix.includes('.')) continue
        expect(
          existsSync(join(REPO, prefix)),
          `filter '${name}' names '${pattern}', but '${prefix}/' does not exist — the pattern ` +
            'can never fire, so its jobs skip forever and read as a pass.',
        ).toBe(true)
      }
    }
  })
})

// ── T2: EXHAUSTIVE coverage, against an authority that is NOT the filter ─────────────────
// This arm has now been wrong twice, in two different ways, and both are worth stating because
// the second is subtler than the first.
//
// v1 asserted ONE representative path per pattern. That cannot see a pattern that matches LESS:
// narrowing `code`'s `map/**` to `map/src/render/**` left `map/src/render/point-renderer.ts`
// matching, so all 29 assertions stayed green while 595 of map's 1013 tracked files — 366 of
// them *.test.ts — stopped setting `code`. The whole @xgis/map unit suite would have merged
// untested with every leg posting green. The row for `pipeline/**` also named a file that does
// not exist and was green anyway, proving the rows never touched the filesystem at all.
//
// v2 read every tracked file, but derived the list of packages to check FROM THE FILTER. That is
// circular, and it failed the same two cuts: deleting `pipeline/**` removed `pipeline` from the
// expected set as well, and narrowing `map/**` to `map/src/render/**` no longer parsed as a
// `<dir>/**` entry so `map` silently dropped out. Both cuts stayed 21/21 green.
//
// v3 takes the expected set from root package.json's `workspaces` — the repo's own authority on
// what packages exist, which the filter cannot edit. Every package there must be fully covered
// by `code`, with exemptions named and argued individually.
const MANIFEST = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  workspaces: readonly string[]
}

/** Packages that exist but are deliberately outside `code`, each with the reason. */
const CODE_EXEMPT: Readonly<Record<string, string>> = {
  site:
    'the site has no vitest here, so a site-only change must not spin up the engine legs; ' +
    'the one page a ratchet reads is listed by name instead (#1700)',
}

/** `code` must fire for every workspace package except the exempt ones, plus `scripts` (which is
 *  not a workspace but whose *.test.ts are in vitest's include — #1700). */
const CODE_MUST_COVER: readonly string[] = [
  ...MANIFEST.workspaces.filter((w) => !(w in CODE_EXEMPT)),
  'scripts',
]

/** `render` covers a deliberate SUBSET, argued per package in the filter's own comments: rhi is
 *  interfaces-only (typecheck-covered) and pipeline is imported only by the seoul-* demos, which
 *  no render-gate spec loads. Pinned here rather than derived, for the same reason as above —
 *  and so that dropping a package from the render filter fails instead of redefining the target.
 *  Widening `render` is fine and does not fail this; narrowing it does. */
const RENDER_MUST_COVER: readonly string[] = [
  'compiler',
  'engine',
  'map',
  'shared',
  'geo',
  'blueprint',
  'shader-dsl',
  'rhi-webgl2',
  'rhi-webgpu',
  'data',
  'playground',
]

/** The ONLY tracked files under those packages that a filter may miss. Measured across 3345
 *  (render) / 3415 (code) tracked files: this is the entire exception set. Shrink-only in both
 *  directions — a new entry is a package losing CI coverage and must be argued for in review. */
const DELIBERATELY_UNMATCHED: Readonly<Record<string, readonly string[]>> = {
  render: ['shader-dsl/CHANGELOG.md'],
  code: ['shader-dsl/CHANGELOG.md'],
  site: [],
}

/** git's idea of what exists, which is the only one that matters to a path filter. */
function trackedUnder(prefix: string): readonly string[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.length > 0)
}

describe('every filter covers every file of every package it must, exhaustively', () => {
  // `site` is here because leaving it out was the same hole one level down: the exhaustive arm
  // witnessed `code` and `render` only, so deleting `site/**` outright left the file 22/22 green
  // while a site-only PR skipped the `site` build job entirely and `test-result` read the skip
  // as a pass. Its floor is separate because the package is an order of magnitude smaller than
  // the engine tree, and a shared floor would be either vacuous for site or unreachable for it.
  const CASES = [
    ['code', CODE_MUST_COVER, 1000],
    ['render', RENDER_MUST_COVER, 1000],
    ['site', ['site'], 100],
  ] as const

  it.each(CASES)(
    '%s: no tracked file of a covered package is silently uncovered',
    (name, pkgs, floor) => {
      const match = matcherFor(name)
      const missed: string[] = []
      let tracked = 0
      for (const pkg of pkgs) {
        const files = trackedUnder(pkg)
        expect(
          files.length,
          `'${pkg}' is required to be covered by '${name}' but git tracks nothing there — either ` +
            'the package moved (update this list AND the filter) or the reader is broken.',
        ).toBeGreaterThan(0)
        tracked += files.length
        for (const file of files) if (!match(file)) missed.push(file)
      }

      expect(tracked, `${name}: only ${tracked} files read — the reader is broken`).toBeGreaterThan(
        floor,
      )
      expect(
        missed.sort(),
        `${name}: ${missed.length} of ${tracked} tracked files in packages this filter must cover ` +
          'do not match it. If a pattern was narrowed or removed, that many files just went ' +
          'CI-dark while every leg still posts green.',
      ).toEqual([...(DELIBERATELY_UNMATCHED[name] ?? [])].sort())
    },
  )

  it('names an exemption for every workspace `code` does not cover', () => {
    // Keeps CODE_EXEMPT honest: an exemption is a decision with a reason, not a gap. If a new
    // workspace appears and nobody wires it into `code`, it lands here rather than nowhere.
    for (const pkg of MANIFEST.workspaces) {
      const covered = CODE_MUST_COVER.includes(pkg)
      const exempt = pkg in CODE_EXEMPT
      expect(
        covered !== exempt,
        `workspace '${pkg}' is neither covered by \`code\` nor listed in CODE_EXEMPT with a reason`,
      ).toBe(true)
    }
  })

  it.each(['code', 'render', 'site'] as const)(
    '%s: each deliberate exception is real and excluded',
    (name) => {
      // Pins the other direction. A stale row here would quietly re-widen the filter, and an
      // exception naming a deleted file would make the arm above vacuous for that entry.
      const match = matcherFor(name)
      for (const file of DELIBERATELY_UNMATCHED[name] ?? []) {
        expect(
          existsSync(join(REPO, file)),
          `${name} excepts '${file}', which does not exist`,
        ).toBe(true)
        expect(match(file), `${name} was supposed to exclude '${file}'`).toBe(false)
      }
    },
  )
})

// ── T2b: the entries that are NOT `<dir>/**` — named files and cross-cutting globs ───────
describe('the non-directory `code` entries still fire', () => {
  const code = matcherFor('code')

  // Each names a concrete file, so each is checked against the filesystem too: a row pointing
  // at a path that no longer exists proves nothing, which is exactly how the first version of
  // this file shipped a green assertion for `pipeline/src/ingest/ingest.ts`.
  const NAMED: readonly string[] = [
    'site/src/pages/shader-dsl/reference.astro',
    'bun.lock',
    'package.json',
    'shader-dsl/package.json',
    'tsconfig.base.json',
    'vitest.config.ts',
    'vitest.setup.ts',
    '.github/workflows/test.yml',
    '.github/workflows/changelog.yml',
    '.github/workflows/mirror-shader-dsl.yml',
  ]

  it.each(NAMED)('%s exists and counts as code', (file) => {
    expect(existsSync(join(REPO, file)), `${file} no longer exists — this row proves nothing`).toBe(
      true,
    )
    expect(code(file), `${file} stopped matching \`code\``).toBe(true)
  })

  it('does not leak outside the packages it names', () => {
    for (const file of ['site/src/pages/index.astro', 'docs/adr/0004-render-verification.md']) {
      expect(code(file), `${file} must not count as code`).toBe(false)
    }
  })
})

// ── T3: the generated changelogs are NOT code, and the trap that would undo it ───────────
describe('the generated changelogs are excluded from `code`', () => {
  const code = matcherFor('code')

  it('excludes both changelog artifacts', () => {
    // Fail-before, stated precisely: only `shader-dsl/CHANGELOG.md` was `true` before the
    // extglob — the ROOT CHANGELOG.md was already outside every `code` and `render` pattern and
    // always has been, so that half of this assertion is inert and is kept only as a regression
    // pin against someone adding a `**/*.md`-shaped entry. An earlier version of this comment
    // said "these were true", which is false for the root file; the measured fail-before was one
    // failing assertion, not two.
    expect(code('shader-dsl/CHANGELOG.md')).toBe(false)
    expect(code('CHANGELOG.md')).toBe(false)
  })

  it('excludes them from `render` TOO — that is the leg that actually starved', () => {
    // `shader-dsl/**` was in BOTH filters, and `render` is the expensive one: render-gate ran
    // 26+ min on the regeneration PR. Excluding the changelog from `code` alone would have cut
    // the matrix and left the starvation exactly where it was, which is the kind of half-fix
    // that reads as done. render-gate's steps are all `if: needs.changes.outputs.render`, so a
    // false `render` makes the whole leg skip in seconds and still post green.
    const render = matcherFor('render')
    expect(render('shader-dsl/CHANGELOG.md')).toBe(false)
    expect(render('CHANGELOG.md')).toBe(false)
    // …while every input the compile gates actually read still fires it (#954).
    expect(render('shader-dsl/src/core/backends/wgsl.ts')).toBe(true)
    expect(render('shader-dsl/src/core/emit.ts')).toBe(true)
    expect(render('geo/src/projections-table.ts')).toBe(true)
    expect(render('map/src/render/point-renderer.ts')).toBe(true)
  })

  it('rejects a leading-`!` pattern, which reads as an exclusion and is not one', () => {
    // Under the pinned `some` quantifier a leading `!` matches nearly EVERY file, so adding
    // one would silently make its filter permanently true. Measured, not assumed:
    const trap = picomatch('!shader-dsl/CHANGELOG.md', MATCH_OPTIONS)
    expect(trap('map/src/render/x.ts')).toBe(true)
    expect(trap('shader-dsl/CHANGELOG.md')).toBe(false)

    for (const [name, patterns] of Object.entries(FILTERS)) {
      for (const pattern of patterns) {
        expect(
          pattern.startsWith('!'),
          `filter '${name}' has '${pattern}'. A leading '!' is an exclusion only under ` +
            '`predicate-quantifier: some-with-excludes`, which needs dorny/paths-filter v4.0.3+; ' +
            'this repo pins @v3. Use an extglob — `dir/**/!(NAME)` — or bump the action AND ' +
            'set the quantifier, and rewrite this arm.',
        ).toBe(false)
      }
    }
  })

  it('pins the quantifier this file assumes', () => {
    // `matcherFor` hardcodes `some`. If a `predicate-quantifier` input ever appears, every
    // assertion above is being evaluated under the wrong rule and this file is lying.
    expect(
      filterStep?.with?.['predicate-quantifier'],
      'the paths-filter step gained a `predicate-quantifier`; matcherFor() replicates the ' +
        'default `some` and must be updated to match before these arms mean anything.',
    ).toBeUndefined()
  })
})

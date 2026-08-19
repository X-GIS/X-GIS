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
// KEEPING IT HONEST WITH THE ACTION. `picomatch` is declared at `^2.3.1`, the range
// dorny/paths-filter declares for itself. If the action's pin moves, move this one with it —
// a gate that replicates a matcher is only as good as the matcher being the same one.

import { describe, expect, it } from 'vitest'
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

// ── T2: `code` still fires for every package it claims to cover ─────────────────────────
// This is the arm that catches a CI-dark package. One representative path per rule: if a
// pattern is edited into something that matches nothing, its row goes red and names it.
describe('the `code` filter fires for real source changes', () => {
  const code = matcherFor('code')

  const COVERED: readonly (readonly [string, string])[] = [
    ['compiler/**', 'compiler/src/tiler/vector-tiler.ts'],
    ['engine/**', 'engine/src/index.ts'],
    ['map/**', 'map/src/render/point-renderer.ts'],
    ['shared/**', 'shared/src/index.ts'],
    ['geo/**', 'geo/src/projection.ts'],
    ['blueprint/**', 'blueprint/src/index.ts'],
    ['shader-dsl/**/!(CHANGELOG.md)', 'shader-dsl/src/core/backends/wgsl.ts'],
    ['rhi/**', 'rhi/src/rhi.ts'],
    ['rhi-webgl2/**', 'rhi-webgl2/src/index.ts'],
    ['rhi-webgpu/**', 'rhi-webgpu/src/index.ts'],
    ['data/**', 'data/src/tile-catalog.ts'],
    ['pipeline/**', 'pipeline/src/ingest/ingest.ts'],
    ['playground/**', 'playground/src/demo-runner.ts'],
    ['scripts/**', 'scripts/emit-changelog.ts'],
    ['the named site page', 'site/src/pages/shader-dsl/reference.astro'],
    ['bun.lock', 'bun.lock'],
    ['root manifest', 'package.json'],
    ['any manifest', 'shader-dsl/package.json'],
    ['tsconfig', 'tsconfig.base.json'],
    ['vitest config', 'vitest.config.ts'],
    ['this workflow', '.github/workflows/test.yml'],
  ]

  it.each(COVERED)('%s → code fires for %s', (_rule, file) => {
    expect(code(file), `${file} no longer matches \`code\` — that package just went CI-dark`).toBe(
      true,
    )
  })

  it('still fires for the shader-dsl paths a changelog exclusion must not touch', () => {
    // The exclusion is one basename. Everything else under the package — including other
    // markdown, including the generated API surface, including depth-1 dotfiles that only
    // match because of `dot: true` — must stay code.
    for (const file of [
      'shader-dsl/src/index.ts',
      'shader-dsl/src/api-surface.test.ts',
      'shader-dsl/src/__api__/surface.md',
      'shader-dsl/examples/__emit-goldens__/color-ramp.wgsl',
      'shader-dsl/README.md',
      'shader-dsl/tsconfig.json',
      'shader-dsl/.npmignore',
      'shader-dsl/CHANGELOG.md.bak',
      'shader-dsl/changelog.md',
    ]) {
      expect(code(file), `${file} must still count as code`).toBe(true)
    }
  })

  it('does not leak outside the packages it names', () => {
    for (const file of ['site/src/pages/index.astro', 'docs/adr/0004.md', 'README.md']) {
      expect(code(file), `${file} must not count as code`).toBe(false)
    }
  })
})

// ── T3: the generated changelogs are NOT code, and the trap that would undo it ───────────
describe('the generated changelogs are excluded from `code`', () => {
  const code = matcherFor('code')

  it('excludes both changelog artifacts', () => {
    // Fail-before: with `shader-dsl/**` these were `true`, which is what made the regeneration
    // PR run the full matrix and starve on `concurrency` cancellation (#1842).
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

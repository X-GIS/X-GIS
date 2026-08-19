// ═══ Something must check the state that actually landed on main (#1872) ═══
//
// A PR run gates a merge only if the merge WAITED for it. #1864 did not: it merged at
// 10:15:21, its `test-result` reported at 10:19:15, and that report was `failure`. main
// stayed broken for 2h36m — a `bun run build` that could not resolve `structCtor` — and
// was found by a person, because nothing in CI ever looked at the merged tree. (#1876
// repeated the pattern three hours later and was merely lucky to come back green.)
//
// The `push: main` trigger that closes this had been REMOVED once, on the premise that
// "every change reaches main through a PR, which already ran this whole workflow". The
// premise is sound wherever the required contexts are actually enforced, and that is
// exactly the assumption that turned out not to hold — which is why it is pinned here
// rather than left to the comment that once argued the other way.
//
// This gate is structural, not behavioural: it asserts the trigger exists and that the
// aggregate context still MEANS something on a push. It cannot tell you the guard ran.
// Deliberately a YAML parse (the idiom paths-filter-semantics.test.ts uses), not the
// raw-text scan in workflow-validity.test.ts: that file scans for text GitHub would
// refuse to parse, where a parse would hide the very comments it must see. The question
// here is structural, so the structure is what to read.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

type Job = { readonly if?: string; readonly needs?: readonly string[] }
type Workflow = {
  readonly on?: { readonly push?: { readonly branches?: readonly string[] } }
  readonly jobs: Readonly<Record<string, Job>>
}

const testWorkflow = (): Workflow =>
  parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')) as Workflow

describe('the post-merge guard on main (#1872)', () => {
  it('parses test.yml into the shape the arms below read', () => {
    // Without this, a renamed job or a restructured `on:` block turns both arms into
    // "nothing found, nothing to assert" — the vacuous-green shape of #996.
    const wf = testWorkflow()
    expect(Object.keys(wf.jobs).length).toBeGreaterThanOrEqual(6)
    expect(wf.jobs['test-result']?.needs?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('test.yml runs on a push to main', () => {
    expect(
      testWorkflow().on?.push?.branches ?? [],
      'test.yml no longer fires on `push: main`, so nothing checks the tree a merge ' +
        'actually produced. That is #1872: a merge that skips its required contexts ' +
        'leaves main unverified, and the PR run it skipped proves nothing about the ' +
        'merged state. Removing this trigger needs a different guard first, not just a ' +
        'runner-minutes argument — that argument is what removed it last time.',
    ).toContain('main')
  })

  it('only pr-title is PR-only among the jobs test-result aggregates', () => {
    // The subtler way to hollow this out: leave the trigger and make the legs PR-only.
    // `test-result` reads a `skipped` upstream as a PASS, so a leg that opts out of
    // push events makes the guard report green having run nothing. `pr-title` is the
    // one legitimate case — a PR title is not a property a push has.
    const wf = testWorkflow()
    const prOnly = (wf.jobs['test-result']?.needs ?? []).filter((n) =>
      (wf.jobs[n]?.if ?? '').includes('pull_request'),
    )
    expect(
      prOnly,
      `${prOnly.join(', ')} skip on a push event yet count toward \`test-result\`, which ` +
        'reads `skipped` as a pass — so the post-merge run would report green with those ' +
        'legs never having run. Only `pr-title` may be PR-only here.',
    ).toEqual(['pr-title'])
  })
})

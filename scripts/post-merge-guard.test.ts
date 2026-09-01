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

type Job = {
  readonly if?: string
  readonly needs?: readonly string[]
  readonly outputs?: Readonly<Record<string, string>>
}
type Workflow = {
  readonly on?: {
    readonly push?: { readonly branches?: readonly string[] }
    readonly schedule?: readonly { readonly cron?: string }[]
  }
  readonly concurrency?: {
    readonly group?: unknown
    readonly 'cancel-in-progress'?: unknown
  }
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

  it('a push run is not cancellable by a later push', () => {
    // The third way to hollow this out, and the one that actually happened — 96
    // seconds after the guard went live. `cancel-in-progress: true` let the
    // changelog regeneration that lands ~90s after every merge cancel the run for
    // the code-bearing commit, and the surviving run was scoped by `changes` to a
    // CHANGELOG-only diff: green on main, zero tests executed. Only-the-tip-matters
    // is true of the tip's state and false of a run's coverage.
    const flag = testWorkflow().concurrency?.['cancel-in-progress']
    expect(
      typeof flag === 'string' && flag.includes('github.event_name'),
      `\`concurrency.cancel-in-progress\` is ${JSON.stringify(flag)} — it must be ` +
        "conditioned on the event (e.g. `${{ github.event_name != 'push' }}`). " +
        'Unconditional cancelling lets the next push to main kill the guard run for ' +
        'the commit that changed code, and the changelog regeneration makes that the ' +
        'normal path, not a race — see the timeline in test.yml`s concurrency note.',
    ).toBe(true)
  })

  // The arm above is the one that was NOT enough, and this is its correction.
  //
  // It watches a FLAG, and the flag was correct the whole time the guard was
  // being hollowed out. `cancel-in-progress: false` does not stop a PENDING run
  // from being superseded: GitHub keeps one pending slot per concurrency group
  // and a newer run cancels the occupant, whatever that flag says. Measured on
  // `bd677c2e` — a code-bearing merge whose run reported
  // `list_workflow_jobs -> total_count: 0`, i.e. no job was ever created (#1963).
  //
  // A guard-run that is cancelled while pending and one that completes leave the
  // flag assertion identically green, so it cannot distinguish the two states it
  // is named for. What DOES distinguish them is the group: give each push its own
  // and there is no shared slot to be evicted from.
  it('a push run cannot be evicted from a shared pending slot', () => {
    const group = testWorkflow().concurrency?.group
    expect(
      typeof group === 'string' && group.includes('github.sha'),
      `\`concurrency.group\` is ${JSON.stringify(group)} — off the pull_request ` +
        'path it must vary per commit (e.g. include `github.sha`). A group shared by ' +
        'every push to main holds ONE pending run, and since a changelog regeneration ' +
        'follows every code merge by ~90 s, the merge that changed code is the one ' +
        'evicted — measured at zero jobs created on bd677c2e (#1963). ' +
        '`cancel-in-progress: false` does not prevent this; only a distinct group does.',
    ).toBe(true)
  })

  // #2135: the render shards do not run on `push`, so main's own CI cannot see a
  // base-red. The schedule is what looks. Both halves are pinned because either
  // one alone is vacuous: a schedule whose `render` filter is false checks out,
  // installs, `if`-skips every step and reports green having rendered nothing.
  it('a schedule patrols main for base-red, and its render filter is forced on', () => {
    const wf = testWorkflow()
    expect(
      (wf.on?.schedule ?? []).length,
      'test.yml has no `schedule:` trigger. The render shards opt out of `push` ' +
        '(they outlast the merge cadence), so without a scheduled run nothing ever ' +
        "renders main's tip — a combination green on every PR and red once merged " +
        'is then only discoverable inside an unrelated pull request, which is how ' +
        '#2135 was found, five runtime merges late.',
    ).toBeGreaterThan(0)

    const render = wf.jobs['changes']?.outputs?.render ?? ''
    expect(
      render.includes('schedule'),
      `\`changes.outputs.render\` is ${JSON.stringify(render)} — it must force ` +
        "'true' on a schedule. A scheduled run has no diff base, so a path filter " +
        'reports no change and every shard step `if`-skips: the job reports GREEN ' +
        'having rendered nothing. That is the same vacuity #2135 exists to end, ' +
        'reintroduced by the patrol itself.',
    ).toBe(true)

    expect(
      wf.jobs['render-shard']?.if ?? '',
      'render-shard must still admit non-push events, or the schedule fires and ' +
        'the shards skip anyway.',
    ).toContain("!= 'push'")
  })
})

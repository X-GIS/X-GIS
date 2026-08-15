// Unit tests for the changelog generator. Everything here runs on the PURE
// half (parseSubject / groupCommits / renderMarkdown) with hand-written
// fixtures — no git process, no repo history — so the tests stay stable as
// `main` moves. The one exception is the entrypoint test at the bottom, which
// spawns the script both ways on purpose.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  groupCommits,
  isRegenCommit,
  parseArgs,
  parseSubject,
  renderMarkdown,
  resolveSince,
  type RawCommit,
} from './emit-changelog'

const commit = (date: string, subject: string, hash = 'abcdef1234567890'): RawCommit => ({
  hash,
  date,
  subject,
})

describe('parseSubject', () => {
  it('reads type, scope and the trailing PR number', () => {
    expect(parseSubject('feat(shader-dsl): textureSampleLevel lint (#1652)')).toEqual({
      type: 'feat',
      scope: 'shader-dsl',
      breaking: false,
      summary: 'textureSampleLevel lint',
      pr: 1652,
    })
  })

  it('handles a scopeless subject', () => {
    expect(parseSubject('fix: stop counting aborts as tile failures (#1595)')).toEqual({
      type: 'fix',
      breaking: false,
      summary: 'stop counting aborts as tile failures',
      pr: 1595,
    })
  })

  it('has no pr when the subject carries none', () => {
    const parsed = parseSubject('feat(shaders): line composer seam for feature-free @stroke')
    expect(parsed.pr).toBeUndefined()
    expect(parsed.summary).toBe('line composer seam for feature-free @stroke')
  })

  it('captures the LAST (#NNN) and leaves the earlier reference in the summary', () => {
    // The real squash-title shape: `(#1650)` is the issue the PR closed, the
    // trailing `(#1652)` is the PR itself. Only the PR becomes the link.
    const parsed = parseSubject('feat(shader-dsl): fragment-only lint (#1650) (#1652)')
    expect(parsed.pr).toBe(1652)
    expect(parsed.summary).toBe('fragment-only lint (#1650)')
  })

  it('leaves a mid-subject (#NNN …) form alone', () => {
    const parsed = parseSubject('feat(map): point composer seam (#1605 Phase 3 PR C) (#1642)')
    expect(parsed.pr).toBe(1642)
    expect(parsed.summary).toBe('point composer seam (#1605 Phase 3 PR C)')
  })

  it('flags the conventional breaking marker', () => {
    const parsed = parseSubject('feat(map,rhi)!: delete the forced-WebGL2 twin frame (#1544)')
    expect(parsed).toMatchObject({ type: 'feat', scope: 'map,rhi', breaking: true })
  })

  it('keeps revert as its own type', () => {
    expect(parseSubject('revert: bring back the old tile budget (#1400)')).toMatchObject({
      type: 'revert',
      summary: 'bring back the old tile budget',
    })
  })

  it('buckets a NON-conventional subject as other, keeping the text whole', () => {
    expect(parseSubject('Merge branch main into feature-x')).toEqual({
      type: 'other',
      breaking: false,
      summary: 'Merge branch main into feature-x',
    })
  })

  it('buckets an unknown type as other rather than inventing a section', () => {
    // `wip` is not in commitlint's type-enum. Nothing is dropped: the whole
    // subject, colon included, survives into the other bucket.
    expect(parseSubject('wip(map): half a thing (#1)')).toEqual({
      type: 'other',
      breaking: false,
      summary: 'wip(map): half a thing',
      pr: 1,
    })
  })

  it('cannot be tricked into an `other` section by a literal `other:` subject', () => {
    expect(parseSubject('other: not a real type')).toMatchObject({
      type: 'other',
      summary: 'other: not a real type',
    })
  })

  it('links a pre-squash-era merge subject by its LEADING PR number', () => {
    // `Merge pull request #NNN from …` carries the PR first, so the trailing-
    // suffix capture misses it — half the shader-dsl view would be linkless.
    expect(parseSubject('Merge pull request #123 from X-GIS/feat/foo')).toEqual({
      type: 'other',
      breaking: false,
      summary: 'Merge pull request #123 from X-GIS/feat/foo',
      pr: 123,
    })
  })

  it('types a GitHub revert-button subject as revert, not other', () => {
    // The button writes `Revert "<original>"`, which is not a conventional
    // commit; 8 of these sat in `other` next to the merge noise while the typed
    // `revert:` spelling got its own section.
    expect(parseSubject('Revert "fix(shader-dsl): guard df64_mul cross terms" (#918)')).toEqual({
      type: 'revert',
      breaking: false,
      summary: 'Revert "fix(shader-dsl): guard df64_mul cross terms"',
      pr: 918,
    })
  })

  it('keeps a revert subject whole, trailing commentary included', () => {
    // Real subject (#1340). The quoted original is the only description a
    // revert carries, so nothing inside or after it may be trimmed away.
    const parsed = parseSubject('Revert "black outline on the S-111 arrow field" — flawed (#1340)')
    expect(parsed.type).toBe('revert')
    expect(parsed.summary).toBe('Revert "black outline on the S-111 arrow field" — flawed')
  })

  it('leaves a merely revert-ISH subject in other', () => {
    // The quote is the marker. `Reverted …` / `revert of …` are prose.
    expect(parseSubject('Reverting the tile budget experiment').type).toBe('other')
  })
})

describe('isRegenCommit', () => {
  it('matches the workflow subject exactly, full or short hash', () => {
    expect(isRegenCommit('chore(changelog): regenerate from 4bf4610')).toBe(true)
    expect(
      isRegenCommit('chore(changelog): regenerate from 4bf461085e22d52de4b3e924dc0371585565ad5e'),
    ).toBe(true)
  })

  it('does NOT match a human commit that merely talks about regeneration', () => {
    // The exclusion is a reserved subject, not a keyword: a real change to the
    // generator must still appear in the changelog it generates.
    expect(isRegenCommit('chore(changelog): regenerate from a clean checkout')).toBe(false)
    expect(isRegenCommit('feat(scripts): regenerate from 4bf4610 on every merge')).toBe(false)
    expect(isRegenCommit('chore(changelog): regenerate from 4bf4610 (#1710)')).toBe(false)
  })
})

describe('groupCommits', () => {
  it('groups by month, newest month first', () => {
    const groups = groupCommits([
      commit('2026-08-01', 'feat(map): august thing'),
      commit('2026-07-31', 'feat(map): july thing'),
      commit('2026-09-02', 'feat(map): september thing'),
    ])
    expect(groups.map((g) => g.month)).toEqual(['2026-09', '2026-08', '2026-07'])
  })

  it('orders types by the fixed section order, not by input order', () => {
    const groups = groupCommits([
      commit('2026-08-04', 'chore(deps): bump'),
      commit('2026-08-03', 'Merge pull request #12'),
      commit('2026-08-02', 'fix(map): a fix'),
      commit('2026-08-01', 'feat(map): a feature'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].types.map((t) => t.type)).toEqual(['feat', 'fix', 'chore', 'other'])
  })

  it('keeps input order (git log is newest-first) inside a type', () => {
    const groups = groupCommits([
      commit('2026-08-09', 'feat(map): newer', 'aaaaaaa0000'),
      commit('2026-08-02', 'feat(map): older', 'bbbbbbb0000'),
    ])
    expect(groups[0].types[0].entries.map((e) => e.summary)).toEqual(['newer', 'older'])
  })

  it('never drops a commit', () => {
    const input = [
      commit('2026-08-04', 'feat(map): a'),
      commit('2026-07-04', 'not conventional at all'),
      commit('2026-07-03', 'perf(render): b (#7)'),
    ]
    const rendered = groupCommits(input).flatMap((g) => g.types.flatMap((t) => t.entries))
    expect(rendered).toHaveLength(input.length)
  })
})

const META = { commit: '4bf461085e22d52de4b3e924dc0371585565ad5e', ref: 'main' }

describe('renderMarkdown', () => {
  it('renders an entry with scope, PR link and short hash', () => {
    const md = renderMarkdown(
      groupCommits([commit('2026-08-11', 'feat(shader-dsl): a thing (#1652)', '4bf46108abcdef')]),
      META,
    )
    expect(md).toContain(
      '- **shader-dsl:** a thing ([#1652](https://github.com/X-GIS/X-GIS/pull/1652)) `4bf4610`',
    )
  })

  it('marks a breaking change in the entry line', () => {
    const md = renderMarkdown(
      groupCommits([commit('2026-08-07', 'feat(map)!: drop the twin frame', '6ffe514aaa')]),
      META,
    )
    expect(md).toContain('- **map:** **BREAKING** drop the twin frame `6ffe514`')
  })

  it('leads the month with breaking changes, above every type section', () => {
    const md = renderMarkdown(
      groupCommits([
        commit('2026-07-20', 'feat(map): a feature', 'aaaaaaa0'),
        commit('2026-07-15', 'refactor!: dissolve @xgis/runtime', '176d4940'),
      ]),
      META,
    )
    expect(md).toContain('#### ⚠ BREAKING CHANGES')
    expect(md.indexOf('#### ⚠ BREAKING CHANGES')).toBeLessThan(md.indexOf('#### feat'))
    expect(md.indexOf('### 2026-07')).toBeLessThan(md.indexOf('#### ⚠ BREAKING CHANGES'))
  })

  it('HOISTS a breaking entry rather than duplicating it into both places', () => {
    // The whole point is prominence, and a commit listed twice would read as two
    // changes. `refactor` held only this entry, so its heading goes with it —
    // an empty `#### refactor` would look like a section that lost its contents.
    const md = renderMarkdown(
      groupCommits([commit('2026-07-15', 'refactor!: dissolve @xgis/runtime', '176d4940')]),
      META,
    )
    expect((md.match(/dissolve @xgis\/runtime/g) ?? []).length).toBe(1)
    expect(md).not.toContain('#### refactor')
  })

  it('keeps the type section for the entries the hoist left behind', () => {
    const md = renderMarkdown(
      groupCommits([
        commit('2026-07-20', 'refactor(map)!: breaking one', 'aaaaaaa0'),
        commit('2026-07-15', 'refactor(map): ordinary one', 'bbbbbbb0'),
      ]),
      META,
    )
    expect(md).toContain('#### refactor')
    expect(md.indexOf('ordinary one')).toBeGreaterThan(md.indexOf('#### refactor'))
    expect(md.indexOf('breaking one')).toBeLessThan(md.indexOf('#### refactor'))
  })

  it('folds pre-squash merge commits into a counted <details>', () => {
    const md = renderMarkdown(
      groupCommits([
        commit('2026-06-20', 'Merge pull request #571 from X-GIS/claude/epic-mayer', 'aaaaaaa0'),
        commit('2026-06-19', 'Merge pull request #570 from X-GIS/fix/glsl-bare', 'bbbbbbb0'),
      ]),
      META,
    )
    expect(md).toContain('<details>')
    expect(md).toContain('<summary>2 pre-squash merge commits</summary>')
    expect(md).toContain('</details>')
    // Folded, never dropped — and still linked.
    expect(md).toContain('https://github.com/X-GIS/X-GIS/pull/571')
    expect((md.match(/^- /gm) ?? []).length).toBe(2)
  })

  it('leaves the fold blank-line-separated so the list is not eaten as raw HTML', () => {
    // CommonMark ends an HTML block at the first blank line; without them the
    // entries render as literal markup instead of a list.
    const md = renderMarkdown(
      groupCommits([commit('2026-06-20', 'Merge pull request #571 from X-GIS/x', 'aaaaaaa0')]),
      META,
    )
    expect(md).toContain('<summary>1 pre-squash merge commit</summary>\n\n- Merge pull request')
    expect(md).toContain('`aaaaaaa`\n\n</details>')
  })

  it('keeps informative other-entries inline, above the fold', () => {
    const md = renderMarkdown(
      groupCommits([
        commit('2026-06-20', 'shader-dsl: diagnostics / error-DX overhaul (#656)', 'aaaaaaa0'),
        commit('2026-06-19', 'Merge pull request #570 from X-GIS/fix/glsl-bare', 'bbbbbbb0'),
      ]),
      META,
    )
    expect(md.indexOf('diagnostics / error-DX overhaul')).toBeLessThan(md.indexOf('<details>'))
    expect((md.match(/^- /gm) ?? []).length).toBe(2)
  })

  it('emits no <details> when a month has no merge commits', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'wip: a thing')]), META)
    expect(md).toContain('#### other')
    expect(md).not.toContain('<details>')
  })

  it('escapes only the renderer-eating characters, keeping authored markdown', () => {
    // Policy: `<`/`>` become raw HTML and swallow the rest of the line; `|` breaks
    // a table cell. Backticks and underscores are DELIBERATE in these subjects
    // (`input` runtime, pattern_lines) and pass through untouched.
    const md = renderMarkdown(
      groupCommits([
        commit('2026-08-05', 'feat(map): `input` runtime for <Layer> | pattern_lines *stars*'),
      ]),
      META,
    )
    expect(md).toContain('`input` runtime for \\<Layer\\> \\| pattern_lines *stars*')
  })

  it('escapes the scope as well', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'fix(a|b): thing')]), META)
    expect(md).toContain('**a\\|b:**')
  })

  it('emits month and type headings at the documented levels', () => {
    const md = renderMarkdown(
      groupCommits([commit('2026-08-05', 'feat(map): a'), commit('2026-07-05', 'fix(map): b')]),
      META,
    )
    expect(md).toContain('### 2026-08')
    expect(md).toContain('#### feat')
    expect(md).toContain('### 2026-07')
    expect(md).toContain('#### fix')
    expect(md.indexOf('### 2026-08')).toBeLessThan(md.indexOf('### 2026-07'))
  })

  it('banners the generated-from commit and the exact regeneration pair', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(map): a')]), META)
    expect(md).toContain('GENERATED FILE — do not hand-edit')
    expect(md).toContain(`Generated from: ${META.commit}`)
    expect(md).toContain('bun scripts/emit-changelog.ts > CHANGELOG.md')
    expect(md).toContain('bunx prettier --write CHANGELOG.md')
    expect(md).toContain('Scope: whole repository')
  })

  it('banners the path-filtered variant with its own command and target', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(shader-dsl): a')]), {
      ...META,
      path: 'shader-dsl',
    })
    expect(md).toContain(
      'bun scripts/emit-changelog.ts --path shader-dsl > shader-dsl/CHANGELOG.md',
    )
    expect(md).toContain('bunx prettier --write shader-dsl/CHANGELOG.md')
    expect(md).toContain('Scope: commits touching shader-dsl/')
    expect(md).toContain('# Changelog — shader-dsl')
  })

  it('states a shallow truncation instead of stopping silently', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(map): a')]), {
      ...META,
      shallowFrom: 'bca19e9cc6bb10e48901dfc7c44ad5747d4e3113',
    })
    expect(md).toContain('SHALLOW clone: nothing before bca19e9cc6bb10e48901dfc7c44ad5747d4e3113')
    expect(md).toContain('shallow clone truncated at `bca19e9`')
  })

  it('stamps no wall-clock time — same history in, same bytes out', () => {
    const commits = [commit('2026-08-05', 'feat(map): a'), commit('2026-07-05', 'fix(map): b')]
    expect(renderMarkdown(groupCommits(commits), META)).toBe(
      renderMarkdown(groupCommits(commits), META),
    )
    // A generation timestamp would show up as a time-of-day or a full ISO stamp.
    expect(renderMarkdown(groupCommits(commits), META)).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('says so when nothing is in scope, rather than emitting a bare heading', () => {
    const md = renderMarkdown(groupCommits([]), META)
    expect(md).toContain('_No commits in scope._')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('ends with exactly one newline (prettier-clean)', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(map): a')]), META)
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })

  it('keeps code spans verbatim — no escapes INSIDE backticks', () => {
    // CommonMark does not process backslash escapes inside a code span, so an
    // escaped pipe there RENDERS as `\|` (the #1656 review's corruption find).
    const md = renderMarkdown(
      groupCommits([commit('2026-08-05', 'feat(map): route `a | b` glyphs <fast>')]),
      META,
    )
    expect(md).toContain('route `a | b` glyphs \\<fast\\>')
  })

  it('renders every entry grouping kept — the render-stage no-drop pin', () => {
    const commits = [
      commit('2026-08-04', 'feat(map): a'),
      commit('2026-07-04', 'not conventional at all'),
      commit('2026-07-03', 'perf(render): b (#7)'),
    ]
    const md = renderMarkdown(groupCommits(commits), META)
    expect((md.match(/^- /gm) ?? []).length).toBe(commits.length)
  })

  it('reproduces a flagged run in the banner, with NO redirect to clobber the artifact', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(map): a')]), {
      ...META,
      since: 'abc123 (exclusive)',
      sinceArg: 'abc123',
    })
    expect(md).toContain('Reproduce this document:')
    expect(md).toContain('bun scripts/emit-changelog.ts --since abc123')
    expect(md).not.toContain('> CHANGELOG.md')
  })

  it('gives the tarball consumer the --since recipe with the stamped hash', () => {
    const md = renderMarkdown(groupCommits([commit('2026-08-05', 'feat(shader-dsl): a')]), {
      ...META,
      path: 'shader-dsl',
    })
    expect(md).toContain(`--path shader-dsl --since ${META.commit.slice(0, 12)}`)
    expect(md).toContain('a listed commit may also')
  })
})

describe('resolveSince', () => {
  it('classifies a resolvable ref as a range bound', () => {
    expect(resolveSince('abc123', () => true)).toEqual({ kind: 'ref', value: 'abc123' })
  })

  it('classifies an ISO date (all three precisions) as a date bound', () => {
    expect(resolveSince('2026', () => false)).toEqual({ kind: 'date', value: '2026' })
    expect(resolveSince('2026-01', () => false)).toEqual({ kind: 'date', value: '2026-01' })
    expect(resolveSince('2026-01-15', () => false)).toEqual({ kind: 'date', value: '2026-01-15' })
  })

  it('rejects garbage LOUDLY instead of letting git approxidate read it as "now"', () => {
    // approxidate parses "banana" as the current time → an empty document that
    // the tarball consumer reads as "nothing changed since my tarball".
    expect(() => resolveSince('banana', () => false)).toThrow(/neither a resolvable ref/)
  })

  it('rejects a year past the approxidate-reliable window (silent no-bound overflow)', () => {
    // Measured on git 2.54: --since=2100-01-01 (and 2999-…) overflows to "no
    // bound" and returns the WHOLE history — the opposite silent-wrong answer.
    expect(() => resolveSince('2100-01-01', () => false)).toThrow(/year 1970-2099/)
    expect(() => resolveSince('2999-01-01', () => false)).toThrow(/year 1970-2099/)
  })
})

describe('parseArgs', () => {
  it('defaults to main with no filters', () => {
    expect(parseArgs([])).toEqual({ ref: 'main' })
  })

  it('reads --ref, --path and --since', () => {
    expect(parseArgs(['--path', 'shader-dsl', '--since', 'v1', '--ref', 'develop'])).toEqual({
      ref: 'develop',
      path: 'shader-dsl',
      since: 'v1',
    })
  })

  it('rejects a flag with no value instead of eating the next flag', () => {
    expect(() => parseArgs(['--path', '--since', '2026-01-01'])).toThrow(/--path needs a value/)
  })

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--format', 'json'])).toThrow(/unknown argument/)
  })
})

describe('entrypoint', () => {
  const script = new URL('./emit-changelog.ts', import.meta.url).pathname
  // The spawned probes below drive the REAL script against THIS repo, so they
  // must skip on exactly the clones that cannot serve them. TWO independent
  // preconditions, both load-bearing:
  //
  //  - the clone is not SHALLOW. This is the same question the script's own
  //    depth guard asks, and asking a DIFFERENT one was the #1720 defect:
  //    `main~5` and `--is-shallow-repository` agree at depth 1 (skip / would
  //    refuse) and at full depth (run / renders), and disagree in the middle.
  //    At `--depth 50` — the container and Claude-Code-on-the-web shape —
  //    `main~5` resolves, so the probes ran, and the script refused by design:
  //    2 red on main, green on CI, which checks out at depth 1.
  //  - `main~5` resolves. The --since probe below names that ref by hand, and
  //    a clone whose local `main` was never created (only origin/main, which
  //    is how this container starts) has no such commit even at full depth.
  //
  // Neither implies the other, so both are checked. The guard itself stays
  // covered everywhere by the tmpdir probe further down, which builds its own
  // shallow clone rather than depending on this one's shape.
  const probeGit = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' })
  const hasDeepHistory =
    probeGit('rev-parse', '--is-shallow-repository').stdout.trim() === 'false' &&
    probeGit('rev-parse', '--verify', '--quiet', 'main~5^{commit}').status === 0

  it.skipIf(!hasDeepHistory)('emits to stdout when run directly', () => {
    const run = spawnSync('bun', [script], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout.startsWith('<!--')).toBe(true)
    expect(run.stdout).toContain('# Changelog')
  })

  it('prints nothing to stdout when merely IMPORTED (the entrypoint guard)', () => {
    // The import.meta.main guard is the mechanism under test: remove it and this
    // import prints the whole changelog, so stdout stops being empty. (This pins
    // the stdout half only — a hypothetical module-scope git call that produces
    // no stdout would pass; the guard wraps main() whole, so none exists.)
    const run = spawnSync('bun', ['--eval', `await import(${JSON.stringify(script)})`], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  it.skipIf(!hasDeepHistory)('resolves a ref --since into an exclusive range (spawned)', () => {
    const run = spawnSync('bun', [script, '--since', 'main~5'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Lower bound: main~5 (exclusive)')
    expect(run.stdout).toContain('bun scripts/emit-changelog.ts --since main~5')
    expect(run.stdout).not.toContain('> CHANGELOG.md')
    expect((run.stdout.match(/^- /gm) ?? []).length).toBe(5)
  })

  it.skipIf(!hasDeepHistory)('treats an ISO-date --since as a date bound (spawned)', () => {
    // Structural assertion only (the banner names the branch taken): asserting
    // emptiness against a live repo would need a future date, and years >= 2100
    // are exactly what resolveSince rejects for approxidate overflow.
    const run = spawnSync('bun', [script, '--since', '2026-01'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Lower bound: --since=2026-01')
    expect(run.stdout).toContain('bun scripts/emit-changelog.ts --since 2026-01')
  })

  it('rejects a --since that is neither a ref nor an ISO date (spawned)', () => {
    const run = spawnSync('bun', [script, '--since', 'banana'], { encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('neither a resolvable ref')
  })

  type Git = (cwd: string, ...args: string[]) => ReturnType<typeof spawnSync>
  type Use = (tmp: string, repo: string, git: Git) => void

  // The two tests below need a repo whose history they CONTROL, which this one
  // is not. Both build a throwaway one and run a COPY of the script from its
  // scripts/ dir — REPO_ROOT is derived from the script's own location, so a
  // copy placed anywhere else would read this repo instead of the fixture.
  const withFixtureRepo = (name: string, build: (repo: string, git: Git) => void, use: Use) => {
    const tmp = mkdtempSync(join(tmpdir(), `emit-changelog-${name}-`))
    try {
      const repo = join(tmp, 'repo')
      const git: Git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
      mkdirSync(repo)
      git(repo, 'init', '-q', '-b', 'main')
      git(repo, 'config', 'user.email', 'test@example.invalid')
      git(repo, 'config', 'user.name', 'Test')
      build(repo, git)
      use(tmp, repo, git)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  const installScript = (repo: string): string => {
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const copied = join(repo, 'scripts', 'emit-changelog.ts')
    copyFileSync(script, copied)
    return copied
  }

  const addCommit = (repo: string, git: Git, subject: string, body = String(subject.length)) => {
    writeFileSync(join(repo, 'a.txt'), body)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', subject, '--no-verify')
  }

  it('refuses an unbounded render from a SHALLOW clone, and still serves a bounded one', () => {
    // The guard standing between CI and a destroyed artifact. `>` truncates the
    // target BEFORE the script runs, so on a depth-1 checkout the old behaviour
    // replaced 249 lines of shader-dsl history with whatever the runner had
    // fetched — measured at 50 commits against 3300 in an agent container.
    // Built on a throwaway 2-commit repo: cloning 498 MB to assert an error
    // message is not a trade worth making.
    withFixtureRepo(
      'shallow',
      (repo, git) => {
        addCommit(repo, git, 'feat: one')
        addCommit(repo, git, 'feat: two')
      },
      (tmp, origin) => {
        const shallow = join(tmp, 'shallow')
        expect(
          spawnSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow], {
            encoding: 'utf8',
          }).status,
        ).toBe(0)
        const copied = installScript(shallow)

        const unbounded = spawnSync('bun', [copied], { encoding: 'utf8' })
        expect(unbounded.status).not.toBe(0)
        expect(unbounded.stderr).toContain('SHALLOW clone')
        expect(unbounded.stderr).toContain('git fetch --unshallow')
        // Nothing reached stdout, so a `>` redirect writes an EMPTY file rather
        // than a plausible-looking stump that reads as the whole history.
        expect(unbounded.stdout).toBe('')

        // The exempt path: an explicit lower bound is a bounded view on purpose,
        // and still says where the clone was cut.
        const bounded = spawnSync('bun', [copied, '--since', '2020-01-01'], { encoding: 'utf8' })
        expect(bounded.status).toBe(0)
        expect(bounded.stdout).toContain('SHALLOW clone: nothing before')
      },
    )
  })

  it('excludes its OWN regeneration commits from the walk (spawned)', () => {
    // Convergence, end to end. isRegenCommit's unit tests pin the predicate;
    // this pins the WIRING — delete the .filter() in main() and every other test
    // in this file still passes while the artifact grows one noise line per
    // merge, forever, which is the failure this whole mechanism exists to stop.
    withFixtureRepo(
      'regen',
      (repo, git) => {
        addCommit(repo, git, 'feat(map): a real change')
        addCommit(repo, git, 'chore(changelog): regenerate from 0123456789abcdef0123')
      },
      (_tmp, repo) => {
        const run = spawnSync('bun', [installScript(repo)], { encoding: 'utf8' })
        expect(run.status).toBe(0)
        expect(run.stdout).toContain('a real change')
        expect(run.stdout).not.toContain('regenerate from')
        // Exactly one entry: the regen commit left no trace, not even a heading.
        expect((run.stdout.match(/^- /gm) ?? []).length).toBe(1)
        expect(run.stdout).not.toContain('#### chore')
      },
    )
  })

  it.skipIf(!hasDeepHistory)('is cwd-independent — spawned from the package dir', () => {
    // Run as `--path shader-dsl` FROM the package dir (the shape shader-dsl's
    // `prepack` used before #1681 C removed it); the -C REPO_ROOT plumbing must
    // keep the pathspec resolving against the repo root, not the caller's cwd.
    const pkgDir = new URL('../shader-dsl/', import.meta.url).pathname
    const run = spawnSync('bun', [script, '--path', 'shader-dsl'], {
      encoding: 'utf8',
      cwd: pkgDir,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Scope: commits touching shader-dsl/')
    expect((run.stdout.match(/^- /gm) ?? []).length).toBeGreaterThan(0)
  })
})

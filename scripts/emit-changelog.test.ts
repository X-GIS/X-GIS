// Unit tests for the changelog generator. Everything here runs on the PURE
// half (parseSubject / groupCommits / renderMarkdown) with hand-written
// fixtures — no git process, no repo history — so the tests stay stable as
// `main` moves. The one exception is the entrypoint test at the bottom, which
// spawns the script both ways on purpose.

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  groupCommits,
  parseArgs,
  parseSubject,
  renderMarkdown,
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

  it('emits to stdout when run directly', () => {
    const run = spawnSync('bun', [script], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout.startsWith('<!--')).toBe(true)
    expect(run.stdout).toContain('# Changelog')
  })

  it('runs no git and prints nothing when merely IMPORTED', () => {
    // The import.meta.main guard is the mechanism under test: remove it and this
    // import prints the whole changelog, so stdout stops being empty.
    const run = spawnSync('bun', ['--eval', `await import(${JSON.stringify(script)})`], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })
})

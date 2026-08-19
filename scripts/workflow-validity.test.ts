// ═══ A workflow file that GitHub cannot parse runs NOTHING, and says so nowhere (#1693) ═══
//
// mirror-shader-dsl.yml was merged on 2026-08-13 and never executed a single job. 56 runs,
// every one `conclusion: failure` with `jobs.total_count: 0` and `run_started_at ===
// updated_at` — an instant startup failure. The cause was one character class in a comment:
//
//     run: |
//       # ... never through a `${{ }}` interpolation ...
//
// GitHub interpolates every expression in a `run:` scalar and does not care that `#` makes
// the line a comment to the SHELL. `${{ }}` is an empty expression, so the file was invalid,
// so nothing in it was ever read.
//
// WHY IT WAS INVISIBLE, which is the part worth engineering against:
//
//   - There is no red X on a PR. A startup failure creates no job, therefore no check run,
//     so the PR shows the same 17 green checks it always did.
//   - The API will not tell you either: `list_workflow_jobs` returns 0, `get_job_logs` says
//     "no failed jobs", and the logs endpoint 404s. The error text lives only in the Actions
//     tab's HTML.
//   - The two symptoms that DO show up read as unrelated curiosities until you connect them:
//     the workflow registered under its own PATH instead of `mirror shader-dsl` (GitHub never
//     got as far as `name:`), and `branches: [main]` was ignored — runs fired on every
//     feature branch, because the trigger filter could not be read either.
//
// So the defect ran for 56 merges, and the whole point of that workflow — publishing
// shader-dsl to the mirror the consuming project takes as a subtree — silently never
// happened. Everything #1719 and #1721 landed sat undelivered.
//
// WHAT THIS GATE CHECKS: every `${{ … }}` in a workflow file is balanced and non-empty.
//
// WHAT IT DOES NOT CHECK, stated so nobody reads green here as "the workflows are valid":
// it does not evaluate expression SYNTAX (`${{ vars. }}` passes here and fails on GitHub),
// and it does not validate the Actions schema. `actionlint` does both and is the right tool
// in CI; this is the zero-dependency floor that catches the class that actually bit, in the
// unit-test leg, with no binary to download.
//
// Deliberately a RAW-TEXT scan rather than a YAML parse: the repo has no YAML parser
// dependency (`Bun.YAML` exists but is undefined inside a vitest worker — vitest runs on
// Node), and hand-rolling enough YAML to tell a comment from a block scalar would be a
// second parser to keep correct. The cost is that an EMPTY `${{ }}` is rejected even in a
// YAML comment, where GitHub would have ignored it. That is a real over-reach and it is the
// right trade: writing `${{ … }}` instead costs nothing, and the alternative is a foot-gun
// that has already eaten 56 runs. The `${{ … }}` spelling in mirror-shader-dsl.yml's R4
// paragraph is exactly this rule being obeyed.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKFLOW_DIR = join(ROOT, '.github/workflows')

const workflowFiles = (): readonly string[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()

/** Every malformed `${{ … }}` in `source`, as human-readable `line N: reason` strings. */
function badExpressions(source: string): readonly string[] {
  const bad: string[] = []
  const lineOf = (i: number) => source.slice(0, i).split('\n').length
  for (let i = source.indexOf('${{'); i !== -1; i = source.indexOf('${{', i + 3)) {
    const close = source.indexOf('}}', i + 3)
    if (close === -1) {
      bad.push(`line ${lineOf(i)}: '\${{' is never closed`)
      break
    }
    const inner = source.slice(i + 3, close)
    if (inner.trim() === '')
      bad.push(`line ${lineOf(i)}: empty expression '\${{${inner}}}' — this is #1693 exactly`)
  }
  return bad
}

describe('workflow files carry no expression GitHub would refuse to parse', () => {
  it('finds the workflow directory — the arm every other one depends on', () => {
    // Without this, a moved directory or a changed extension turns every set-comparison
    // below into "no files, no failures" and the gate reports green on nothing at all.
    expect(workflowFiles().length).toBeGreaterThanOrEqual(4)
    expect(workflowFiles()).toContain('mirror-shader-dsl.yml')
  })

  it.each(workflowFiles())('%s has no empty or unclosed expression', (file) => {
    expect(badExpressions(readFileSync(join(WORKFLOW_DIR, file), 'utf8'))).toEqual([])
  })

  it.each(workflowFiles())('%s declares a name and a trigger block', (file) => {
    // Both are what GitHub failed to read for #1693. Their PRESENCE never was the defect,
    // so this arm cannot catch that bug — it is here because a workflow missing either is
    // a different, equally silent way to get a run nobody can find.
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    expect(source).toMatch(/^name:\s*\S/m)
    expect(source).toMatch(/^on:\s*$/m)
  })
})

describe('the scanner distinguishes the states it claims to', () => {
  it('rejects the exact line that broke mirror-shader-dsl.yml', () => {
    // Byte-for-byte the comment as it was merged, so this arm decays only if the incident
    // itself is misremembered.
    const historical = '          # through a `${{ }}` interpolation (which lands in the'
    expect(badExpressions(historical)).toHaveLength(1)
    expect(badExpressions(historical)[0]).toMatch(/empty expression/)
  })

  it('rejects an unclosed expression', () => {
    expect(badExpressions('env:\n  A: ${{ vars.X\n')[0]).toMatch(/never closed/)
  })

  it('accepts the real expressions the corpus depends on', () => {
    // The arms above would all pass on a scanner that flagged everything; this is what
    // makes them mean something.
    expect(
      badExpressions(
        [
          '${{ vars.SHADER_DSL_MIRROR_REPO }}',
          "${{ secrets.SHADER_DSL_MIRROR_TOKEN != '' }}",
          '${{ github.event_name }}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts the `${{ … }}` spelling the fix uses to name the form safely', () => {
    // The whole reason mirror-shader-dsl.yml can still document the hazard it hit.
    expect(badExpressions('# never through a `${{ … }}` interpolation')).toEqual([])
  })

  it('reports EVERY bad expression in a file, not just the first', () => {
    // One-per-run would turn a multi-site fix into a multi-round guessing game.
    expect(badExpressions('a: ${{ }}\nb: ${{  }}\n')).toHaveLength(2)
  })
})

// ═══ A warmer that warms a key nothing reads is worth exactly nothing (#1851) ═══
//
// `ci-cache.yml` exists only to write `test.yml`'s cache entries on the DEFAULT
// branch, because GitHub scopes a cache to the ref that wrote it and `test.yml`
// runs on `pull_request` only — so a PR can read main's entry and no other PR's.
// The whole benefit therefore rests on one string equality: the warmer's `key:`
// must be byte-identical to the consumer's. Nothing enforces that at runtime.
//
// A drifted key fails SILENTLY and in the most expensive direction available: the
// warmer still runs green (it happily writes a key), `test.yml` still runs green
// (it just misses and downloads), and the only symptom is CI slowly getting
// slower again — the exact condition #1851 was filed to remove. There is no red X
// anywhere, which is the same shape as #1693 above and the reason both live here.
//
// Stated as SET EQUALITY, in both directions, so either drift is named:
//   • a cache in `test.yml` that nothing warms  → cold on every PR's first run
//   • a key warmed that `test.yml` never reads  → an entry written for no reader
function cacheKeys(source: string): readonly string[] {
  // Raw text, not a YAML parse, for this file's stated reason (`Bun.YAML` is
  // undefined inside a vitest worker). `restore-keys:` does not match — the
  // anchor requires the property to BE `key`, and an arm below pins that.
  return [...new Set(Array.from(source.matchAll(/^\s+key:\s*(\S.*?)\s*$/gm), (m) => m[1]))].sort()
}

describe('every cache `test.yml` reads is one `ci-cache.yml` warms (#1851)', () => {
  const consumer = () => readFileSync(join(WORKFLOW_DIR, 'test.yml'), 'utf8')
  const warmer = () => readFileSync(join(WORKFLOW_DIR, 'ci-cache.yml'), 'utf8')

  it('both files exist and yield keys — otherwise the comparison below is vacuous', () => {
    // Two empty sets are equal. Without this arm, deleting either file, renaming a
    // property, or breaking the regex turns the real check into a green no-op.
    expect(workflowFiles()).toContain('test.yml')
    expect(workflowFiles()).toContain('ci-cache.yml')
    expect(cacheKeys(consumer()).length).toBeGreaterThanOrEqual(2)
    expect(cacheKeys(warmer()).length).toBeGreaterThanOrEqual(2)
  })

  it('warms exactly the keys the consumer reads — no unwarmed cache, no unread entry', () => {
    const read = cacheKeys(consumer())
    const warmed = cacheKeys(warmer())
    expect(
      read.filter((k) => !warmed.includes(k)),
      'these cache keys are read by .github/workflows/test.yml but warmed by nothing, so ' +
        'every PR pays them cold on its first run (a PR cannot read another PR’s cache ' +
        '— only main’s). Add each to .github/workflows/ci-cache.yml, byte-identical.',
    ).toEqual([])
    expect(
      warmed.filter((k) => !read.includes(k)),
      'these cache keys are warmed by .github/workflows/ci-cache.yml but read by nothing in ' +
        'test.yml — either the consumer’s key drifted (in which case fix the drift, ' +
        'not this list) or the entry is dead weight against the repo’s 10 GB cache quota.',
    ).toEqual([])
  })
})

describe('the key scanner distinguishes the states it claims to', () => {
  it('sees a drifted key as a difference, not a match', () => {
    // The mutation this gate exists to catch: one character in the warmer's key.
    const before = cacheKeys(
      '      - uses: actions/cache@v4\n        with:\n          key: pw-Linux-1.60.0\n',
    )
    const after = cacheKeys(
      '      - uses: actions/cache@v4\n        with:\n          key: pw-Linux-1.61.0\n',
    )
    expect(before).toEqual(['pw-Linux-1.60.0'])
    expect(after).toEqual(['pw-Linux-1.61.0'])
    expect(before).not.toEqual(after)
  })

  it('does NOT mistake `restore-keys:` for `key:`', () => {
    // test.yml's bun cache carries both; counting the restore prefix as a key would
    // demand the warmer write a bare `bun-Linux-` entry that must never exist.
    expect(cacheKeys('          key: bun-Linux-abc\n          restore-keys: bun-Linux-\n')).toEqual(
      ['bun-Linux-abc'],
    )
  })

  it('collapses the same key repeated across jobs', () => {
    // test.yml declares the bun cache in 5 jobs; a set comparison must see one key.
    expect(cacheKeys('          key: bun-Linux-abc\n          key: bun-Linux-abc\n')).toEqual([
      'bun-Linux-abc',
    ])
  })

  it('ignores a `key:` that is not a property (no leading indent)', () => {
    expect(cacheKeys('key: not-a-workflow-cache\n')).toEqual([])
  })
})

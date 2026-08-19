#!/usr/bin/env bun
// emit-changelog — render a Markdown changelog from the repo's git history.
//
// git history is the SINGLE AUTHORITY here. The repo squash-merges to a linear
// `main` with conventional-commit titles (`<type>(scope): summary (#NNN)` —
// docs/BRANCHING.md, enforced by commitlint.config.js), so the first-parent log
// already IS the change record; a hand-maintained CHANGELOG.md would be a second
// authority and would drift from it.
//
// There are no versioned releases and no git tags in this repo (BRANCHING.md:
// "no versioned releases; we do not bump package versions"), so entries group by
// MONTH rather than by version — and version-driven tooling (changesets,
// conventional-changelog) has nothing to key on. Hence this generator, zero deps.
//
// Output: Markdown on STDOUT — the caller redirects (mirrors emit-gap-matrix.ts).
// Nothing here reads the wall clock: the same history in gives byte-identical
// output, so a regeneration only diffs when the history actually moved.
//
// Regenerate (generate BOTH artifacts, then format — the raw output is already
// prettier-clean, so the pair is idempotent):
//   bun scripts/emit-changelog.ts > CHANGELOG.md
//   bun scripts/emit-changelog.ts --path shader-dsl > shader-dsl/CHANGELOG.md
//   bunx prettier --write CHANGELOG.md shader-dsl/CHANGELOG.md
// or, equivalently: bun run changelog
//
// The `>` redirect truncates the target BEFORE the script runs (inherent to the
// STDOUT contract), so a failed run leaves an empty artifact: recover with
// `git checkout -- <file>` and re-run. A SHALLOW clone would make that truncation
// permanent and silent — see the depth guard in main().
//
// FRESHNESS. There is still no PR-time staleness gate, and #1653's decision not
// to add one was right for a reason stronger than churn: an entry's text is the
// SQUASH SUBJECT, which does not exist until the merge happens. A pre-merge
// check has nothing to check. Regeneration can therefore only ever run AFTER a
// merge, on main — which is what .github/workflows/changelog.yml now does on
// every push to main. Before it existed, the only automatic keeper was
// shader-dsl's `prepack`; that went away with the npm story (#1681 C) and was
// replaced by nothing, so both artifacts sat 16 (shader-dsl) and 27 (repo)
// commits stale — this generator's own landing commit among the missing.
// `bun run changelog` remains the manual path; nothing depends on a human
// running it.
//
// Flags (all accept `--flag value` and `--flag=value`):
//   --ref <branch>      history to walk (default: main)
//   --path <dir>        only commits touching <dir> — the view an external
//                       consumer of a package tarball needs (--path shader-dsl)
//   --since <ref|date>  lower bound. A resolvable ref/hash walks <ref>..<walked
//                       ref>; an ISO date (YYYY[-MM[-DD]]) becomes git's
//                       --since=<date>; anything else is an ERROR — git's
//                       approxidate would parse garbage as "now" and render an
//                       empty document that reads as "no changes".

import { spawnSync } from 'node:child_process'

const REPO_URL = 'https://github.com/X-GIS/X-GIS'
// Derived from this file's own location (scripts/ sits at the repo root), NOT
// from a git call — importing this module must never shell out. Every git
// invocation runs `-C REPO_ROOT`, so the script is callable from any cwd
// (`emit-changelog.test.ts` spawns it from shader-dsl/) and a pathspec like
// `-- shader-dsl` always resolves against the repo root.
const REPO_ROOT = new URL('..', import.meta.url).pathname

// commitlint.config.js `type-enum` is the authority for what counts as a known
// type; this array additionally fixes the SECTION ORDER (user-visible change
// first, housekeeping last). Anything not in here — an unknown type, or a
// subject that is not a conventional commit at all — lands in `other` rather
// than being dropped.
const TYPE_ORDER = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
  'other',
] as const

const KNOWN_TYPES = new Set<string>(TYPE_ORDER)

/** One line of `git log --pretty=format:%H<US>%ad<US>%s --date=short`. */
export interface RawCommit {
  hash: string
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string
  subject: string
}

export interface ParsedSubject {
  /** A commitlint type, or `other` for unknown/unparseable subjects. */
  type: string
  scope?: string
  /** `type(scope)!:` — the conventional breaking-change marker. */
  breaking: boolean
  /** For `other`, the raw subject (minus the trailing PR ref). */
  summary: string
  /** The LAST trailing `(#NNN)` — the squash-merge PR number. */
  pr?: number
}

export interface ChangelogEntry extends ParsedSubject {
  hash: string
  date: string
}

export interface MonthGroup {
  /** `YYYY-MM`. */
  month: string
  types: { type: string; entries: ChangelogEntry[] }[]
}

export interface RenderMeta {
  /** Full hash of the walked ref's HEAD — what the file was generated from. */
  commit: string
  /** The walked ref, e.g. `main`. */
  ref: string
  /** Path filter, when one was given. */
  path?: string
  /** Human-readable lower bound, when one was given. */
  since?: string
  /** The RAW --since value, for reproducing the exact command in the banner. */
  sinceArg?: string
  /**
   * Oldest hash present when the checkout is a SHALLOW clone. A shallow clone
   * renders a changelog that simply stops, with nothing to say it was cut —
   * exactly the silent truncation this repo does not tolerate — so the cut is
   * stated in the file. Absent (and the note gone) in a full clone.
   */
  shallowFrom?: string
}

// A trailing `(#NNN)`. Squash titles carry the PR number last and may repeat the
// form mid-subject (`… (#1605 Phase 3 PR C) (#1642)`); anchoring to the end and
// stripping ONE group therefore takes the PR and leaves any referenced issue
// number in the summary text where its author put it.
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/
// Pre-squash-era merge commits carry the PR number FIRST (`Merge pull request
// #NNN from …`), so PR_SUFFIX misses them — nearly half the shader-dsl view's
// entries would render linkless without this. Also the fold predicate: these
// carry a branch name where a summary should be, so they render collapsed
// (renderOther) rather than inline. Matched against the SUMMARY, which for an
// `other` entry is the subject minus its trailing PR ref.
const MERGE_PR = /^Merge pull request #(\d+)\b/
// GitHub's revert button writes `Revert "<original subject>"`, which is not a
// conventional commit and fell into `other` — 8 of them, next to the merge
// noise, while `revert:` (the typed spelling) got its own section. Same event,
// two places.
const REVERT_SUBJECT = /^Revert "/
// The subject .github/workflows/changelog.yml commits its own regeneration with,
// and the one subject this generator excludes from the walk. Without it the
// artifact never converges: each merge's regen commit is itself a `chore` entry,
// so the next run finds a diff, commits, and the file grows one noise line per
// merge forever. Excluding it is not dropping history — it is keeping the
// observer out of the observation; nothing else in the log is filtered.
// Reserved and exact: a human writing about this feature cannot trip it.
//
// The `(#NNN)` suffix is OPTIONAL because the workflow reaches main through a PR
// rather than a direct push (#1842 — the direct push was rejected by branch
// protection on all 90 of its runs), and GitHub's squash appends the PR number to
// the subject it lands. Anchoring at `$` without it left the landed regen commit
// unexcluded, which is precisely the never-converging case above.
const REGEN_SUBJECT = /^chore\(changelog\): regenerate from [0-9a-f]{7,40}(?: \(#\d+\))?$/

/** True for the changelog workflow's own regeneration commits. */
export const isRegenCommit = (subject: string): boolean => REGEN_SUBJECT.test(subject.trim())

/** Parse a commit subject. Never throws, never drops: unparseable → `other`. */
export function parseSubject(subject: string): ParsedSubject {
  const trimmed = subject.trim()
  const prMatch = PR_SUFFIX.exec(trimmed)
  const pr = prMatch ? Number(prMatch[1]) : undefined
  const head = prMatch ? trimmed.slice(0, prMatch.index) : trimmed

  const conv = CONVENTIONAL.exec(head)
  if (!conv || !KNOWN_TYPES.has(conv[1]) || conv[1] === 'other') {
    // Kept WHOLE (quotes and all): the reverted subject is the only description
    // a revert has, so trimming it to the inner text would lose the `Revert`.
    if (REVERT_SUBJECT.test(head)) {
      return { type: 'revert', breaking: false, summary: head, ...(pr ? { pr } : {}) }
    }
    const mergePr = pr === undefined ? MERGE_PR.exec(head) : null
    const linkPr = pr ?? (mergePr ? Number(mergePr[1]) : undefined)
    return { type: 'other', breaking: false, summary: head, ...(linkPr ? { pr: linkPr } : {}) }
  }
  return {
    type: conv[1],
    ...(conv[2] ? { scope: conv[2] } : {}),
    breaking: conv[3] === '!',
    summary: conv[4],
    ...(pr ? { pr } : {}),
  }
}

/**
 * Group commits by month (newest month first), then by TYPE_ORDER. Entry order
 * within a type is the input order, which for `git log` is newest-first.
 */
export function groupCommits(commits: RawCommit[]): MonthGroup[] {
  const byMonth = new Map<string, Map<string, ChangelogEntry[]>>()
  for (const commit of commits) {
    const month = commit.date.slice(0, 7)
    let types = byMonth.get(month)
    if (!types) byMonth.set(month, (types = new Map()))
    const entry: ChangelogEntry = {
      ...parseSubject(commit.subject),
      hash: commit.hash,
      date: commit.date,
    }
    const bucket = types.get(entry.type)
    if (bucket) bucket.push(entry)
    else types.set(entry.type, [entry])
  }

  return [...byMonth.keys()]
    .sort()
    .reverse()
    .map((month) => ({
      month,
      types: TYPE_ORDER.filter((type) => byMonth.get(month)!.has(type)).map((type) => ({
        type,
        entries: byMonth.get(month)!.get(type)!,
      })),
    }))
}

// Escaping policy: commit subjects are prose that already uses DELIBERATE
// markdown (`` `input` runtime ``, `pattern_lines`), so backticks, underscores
// and asterisks pass through verbatim — rendering them as the author wrote them
// is the intent, and CommonMark leaves intra-word underscores alone. Escaped are
// only the characters that would make a renderer EAT text: `<`/`>` (parsed as
// raw HTML, swallowing the rest of the line) and `|` (a table-cell break, should
// an entry ever be pasted into one) — and ONLY outside code spans: CommonMark
// does not process backslash escapes inside backticks, so escaping there would
// RENDER the backslash (`` `\| flow` `` — the #1656 review's corruption find).
// Nothing is ever dropped.
const CODE_SPAN = /(`+)[\s\S]*?\1/g
const escapeProse = (text: string): string => text.replace(/[<>|]/g, (ch) => `\\${ch}`)
function escapeInline(text: string): string {
  let out = ''
  let last = 0
  CODE_SPAN.lastIndex = 0
  for (let m = CODE_SPAN.exec(text); m !== null; m = CODE_SPAN.exec(text)) {
    out += escapeProse(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + escapeProse(text.slice(last))
}

function renderEntry(entry: ChangelogEntry): string {
  const scope = entry.scope ? `**${escapeInline(entry.scope)}:** ` : ''
  const breaking = entry.breaking ? '**BREAKING** ' : ''
  const pr = entry.pr ? ` ([#${entry.pr}](${REPO_URL}/pull/${entry.pr}))` : ''
  return `- ${scope}${breaking}${escapeInline(entry.summary)}${pr} \`${entry.hash.slice(0, 7)}\``
}

// Hoisted ABOVE the type sections of its month rather than duplicated into
// both: `refactor!: dissolve @xgis/runtime` (#1343) was previously the 1st of 9
// lines under 2026-07's `#### refactor`, indistinguishable at a glance from a
// rename — in a package that reaches external consumers through the mirror.
// Every entry still renders exactly once (the render-stage no-drop pin counts
// `^- ` lines against the input length, and would catch a duplicate).
const BREAKING_HEADING = '⚠ BREAKING CHANGES'

// Pre-squash-era merge commits carry a BRANCH NAME where a summary should be
// (`Merge pull request #571 from X-GIS/claude/epic-mayer-ewb9kl`): 85 of the
// shader-dsl view's 192 entries — 44% of the file — saying nothing the PR link
// does not. They are real history, so they are FOLDED, never dropped, and the
// <summary> states the count so a fold can never be misread as a truncation.
function renderOther(entries: ChangelogEntry[]): string[] {
  const merges = entries.filter((entry) => MERGE_PR.test(entry.summary))
  const rest = entries.filter((entry) => !MERGE_PR.test(entry.summary))
  const lines = rest.map(renderEntry)
  if (merges.length === 0) return lines
  if (rest.length > 0) lines.push('')
  // The blank lines are load-bearing: CommonMark ends an HTML block at the
  // first blank line, so without them the list would be swallowed as raw HTML.
  lines.push('<details>')
  lines.push(
    `<summary>${merges.length} pre-squash merge commit${merges.length === 1 ? '' : 's'}</summary>`,
  )
  lines.push('')
  lines.push(...merges.map(renderEntry))
  lines.push('')
  lines.push('</details>')
  return lines
}

/** Render the full document, banner included. Ends with exactly one newline. */
export function renderMarkdown(groups: MonthGroup[], meta: RenderMeta): string {
  // The banner command reproduces THIS document — every non-default flag is
  // included (a --since document used to print the flagless command, which
  // produces a DIFFERENT file and, pasted with the redirect, overwrites the
  // committed artifact with a truncated one).
  const flags =
    (meta.ref !== 'main' ? ` --ref ${meta.ref}` : '') +
    (meta.path ? ` --path ${meta.path}` : '') +
    (meta.sinceArg ? ` --since ${meta.sinceArg}` : '')
  const command = `bun scripts/emit-changelog.ts${flags}`
  const isCanonicalArtifact = meta.ref === 'main' && meta.sinceArg === undefined
  const target = meta.path ? `${meta.path}/CHANGELOG.md` : 'CHANGELOG.md'
  const lines: string[] = []

  lines.push('<!--')
  lines.push('  GENERATED FILE — do not hand-edit; every edit is lost on the next run.')
  lines.push('  Rendered from git history by scripts/emit-changelog.ts.')
  lines.push('')
  if (isCanonicalArtifact) {
    lines.push('  Regenerate (both steps — the generator emits prettier-clean markdown,')
    lines.push('  and the pair is idempotent):')
    lines.push(`    ${command} > ${target}`)
    lines.push(`    bunx prettier --write ${target}`)
  } else {
    // A flagged run is an ad-hoc view — no redirect target, so the command
    // cannot be pasted into clobbering the committed artifact.
    lines.push('  Reproduce this document:')
    lines.push(`    ${command}`)
  }
  lines.push('')
  lines.push(`  Generated from: ${meta.commit}`)
  lines.push(`  History walked: first-parent of ${meta.ref}`)
  lines.push(`  Scope: ${meta.path ? `commits touching ${meta.path}/` : 'whole repository'}`)
  if (meta.since) lines.push(`  Lower bound: ${meta.since}`)
  lines.push(`  Repository: ${REPO_URL}`)
  lines.push('  What changed since this file was generated (run from a repo checkout):')
  lines.push(
    `    bun scripts/emit-changelog.ts${meta.path ? ` --path ${meta.path}` : ''} --since ${meta.commit.slice(0, 12)}`,
  )
  if (meta.shallowFrom) {
    lines.push(`  SHALLOW clone: nothing before ${meta.shallowFrom} exists in this checkout.`)
  }
  lines.push('-->')
  lines.push('')
  lines.push(`# Changelog${meta.path ? ` — ${meta.path}` : ''}`)
  lines.push('')
  lines.push(
    'This repo ships no versioned releases and carries no git tags, so changes are' +
      ' grouped by month rather than by version. Each entry is one squash-merged' +
      ' commit on `main`; the short hash is the point in history it landed at.',
  )
  lines.push('')
  if (meta.path) {
    lines.push(
      `_Entries are the commits touching \`${meta.path}/\`; a listed commit may also` +
        ' touch other packages._',
    )
    lines.push('')
  }
  if (meta.shallowFrom) {
    lines.push(
      `_Generated in a shallow clone truncated at \`${meta.shallowFrom.slice(0, 7)}\` — history` +
        ' before that commit is absent, so this list does not reach the start of the project.' +
        ' Regenerate from a full clone for the whole history._',
    )
    lines.push('')
  }

  if (groups.length === 0) {
    lines.push('_No commits in scope._')
    lines.push('')
    return lines.join('\n')
  }

  for (const group of groups) {
    lines.push(`### ${group.month}`)
    lines.push('')
    const breaking = group.types.flatMap(({ entries }) => entries.filter((e) => e.breaking))
    if (breaking.length > 0) {
      lines.push(`#### ${BREAKING_HEADING}`)
      lines.push('')
      for (const entry of breaking) lines.push(renderEntry(entry))
      lines.push('')
    }
    for (const { type, entries } of group.types) {
      // What the hoist left behind. A type whose every entry was breaking emits
      // NO heading — an empty `#### refactor` would read as a lost section.
      const kept = entries.filter((e) => !e.breaking)
      if (kept.length === 0) continue
      lines.push(`#### ${type}`)
      lines.push('')
      lines.push(...(type === 'other' ? renderOther(kept) : kept.map(renderEntry)))
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ───── CLI ─────

interface Options {
  ref: string
  path?: string
  since?: string
}

/** Minimal hand-rolled flag parsing — no dependency, and there are three flags.
 *  Accepts both `--flag value` and `--flag=value`. */
export function parseArgs(argv: string[]): Options {
  const opts: Options = { ref: 'main' }
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]
    let value: string | undefined
    const eq = flag.indexOf('=')
    if (flag.startsWith('--') && eq > 2) {
      value = flag.slice(eq + 1)
      flag = flag.slice(0, eq)
    }
    if (flag === '--ref' || flag === '--path' || flag === '--since') {
      if (value === undefined) {
        value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`emit-changelog: ${flag} needs a value`)
        }
        i++
      }
      if (flag === '--ref') opts.ref = value
      else if (flag === '--path') opts.path = value
      else opts.since = value
    } else {
      throw new Error(`emit-changelog: unknown argument '${flag}'`)
    }
  }
  return opts
}

/** Classify a --since value: a resolvable ref/hash, an ISO date, or an ERROR.
 *  Without the date check, git's approxidate parses garbage ("banana") as "now"
 *  and the document renders `_No commits in scope._` — which the tarball
 *  consumer reads as "nothing changed since my tarball". Loud beats silently
 *  wrong. `refExists` is injected so the classification is unit-testable
 *  without a live repo. */
export function resolveSince(
  since: string,
  refExists: (value: string) => boolean,
): { kind: 'ref' | 'date'; value: string } {
  if (refExists(since)) return { kind: 'ref', value: since }
  // Years are bounded to git approxidate's RELIABLE window: measured on git
  // 2.54, `--since=2100-01-01` (and beyond) silently overflows to "no bound"
  // and returns the WHOLE history — "everything changed since my tarball", the
  // exact silent-wrong answer this check exists to prevent.
  if (/^(19[7-9]\d|20\d{2})(-\d{2}){0,2}$/.test(since)) return { kind: 'date', value: since }
  throw new Error(
    `emit-changelog: --since '${since}' is neither a resolvable ref/hash nor an ISO date` +
      ` (YYYY[-MM[-DD]], year 1970-2099)`,
  )
}

function git(args: string[]): string {
  // Args are passed as an array — never interpolated into a shell string.
  const run = spawnSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${run.status ?? 'signal'}): ${run.stderr}`)
  }
  return run.stdout
}

/** True when `value` names a commit git can resolve (so it is a ref, not a date). */
function isRef(value: string): boolean {
  return (
    spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', `${value}^{commit}`], {
      encoding: 'utf8',
    }).status === 0
  )
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const since = opts.since !== undefined ? resolveSince(opts.since, isRef) : undefined
  const sinceIsRef = since?.kind === 'ref'

  // A shallow checkout (CI's depth-1 default, agent containers) walks only the
  // commits it happens to have. UNBOUNDED, that is a silent lie: the document
  // claims to reach the start of the project and stops wherever the graft is,
  // and because `>` truncates the target BEFORE this runs, `bun run changelog`
  // in such a checkout REPLACES the full artifact with the stump. Measured: a
  // 50-commit container against 3300 first-parent commits — 249 lines of
  // shader-dsl history down to a handful. Refusing is the whole guard; the
  // shallowFrom banner below is only honest once the file is not the artifact.
  // A --since run is exempt: its lower bound is stated, so a short walk is what
  // was asked for.
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
  if (shallow && opts.since === undefined) {
    throw new Error(
      'emit-changelog: refusing to render an unbounded changelog from a SHALLOW clone —' +
        ' the result would silently truncate the committed artifact.' +
        ' Run `git fetch --unshallow` first (CI: actions/checkout with fetch-depth: 0),' +
        ' or pass --since <ref|YYYY-MM-DD> to ask for a bounded view on purpose.',
    )
  }

  const args = [
    'log',
    '--first-parent',
    sinceIsRef ? `${opts.since!}..${opts.ref}` : opts.ref,
    '--pretty=format:%H\x1f%ad\x1f%s',
    '--date=short',
  ]
  if (since !== undefined && since.kind === 'date') args.push(`--since=${since.value}`)
  if (opts.path !== undefined) args.push('--', opts.path)

  const commits: RawCommit[] = git(args)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, date, ...rest] = line.split('\x1f')
      return { hash, date, subject: rest.join('\x1f') }
    })
    .filter((commit) => !isRegenCommit(commit.subject))

  // Only reachable on a --since run now (the guard above rejects the unbounded
  // case): the walk still stops at the graft, so the cut stays named in the file.
  const shallowFrom = shallow ? git(['rev-list', '--max-parents=0', opts.ref]).split('\n')[0] : ''

  const meta: RenderMeta = {
    commit: git(['rev-parse', opts.ref]).trim(),
    ref: opts.ref,
    ...(shallowFrom ? { shallowFrom } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.since !== undefined
      ? {
          since: sinceIsRef ? `${opts.since} (exclusive)` : `--since=${opts.since}`,
          sinceArg: opts.since,
        }
      : {}),
  }

  // Emit to stdout — the caller redirects (see the header).
  process.stdout.write(renderMarkdown(groupCommits(commits), meta))
}

// Bun's main-module flag. The repo has no bun-types, so it is narrowed here
// rather than paying a dependency for one boolean. Importing this module (the
// unit tests do) must never shell out to git.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) main()

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
// Flags:
//   --ref <branch>      history to walk (default: main)
//   --path <dir>        only commits touching <dir> — the view an external
//                       consumer of a package tarball needs (--path shader-dsl)
//   --since <ref|date>  lower bound. A resolvable ref/hash walks <ref>..<walked
//                       ref>; anything else is passed as git's --since=<date>.

import { spawnSync } from 'node:child_process'

const REPO_URL = 'https://github.com/X-GIS/X-GIS'

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

/** Parse a commit subject. Never throws, never drops: unparseable → `other`. */
export function parseSubject(subject: string): ParsedSubject {
  const trimmed = subject.trim()
  const prMatch = PR_SUFFIX.exec(trimmed)
  const pr = prMatch ? Number(prMatch[1]) : undefined
  const head = prMatch ? trimmed.slice(0, prMatch.index) : trimmed

  const conv = CONVENTIONAL.exec(head)
  if (!conv || !KNOWN_TYPES.has(conv[1]) || conv[1] === 'other') {
    return { type: 'other', breaking: false, summary: head, ...(pr ? { pr } : {}) }
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
// an entry ever be pasted into one). Nothing is ever dropped.
function escapeInline(text: string): string {
  return text.replace(/[<>|]/g, (ch) => `\\${ch}`)
}

function renderEntry(entry: ChangelogEntry): string {
  const scope = entry.scope ? `**${escapeInline(entry.scope)}:** ` : ''
  const breaking = entry.breaking ? '**BREAKING** ' : ''
  const pr = entry.pr ? ` ([#${entry.pr}](${REPO_URL}/pull/${entry.pr}))` : ''
  return `- ${scope}${breaking}${escapeInline(entry.summary)}${pr} \`${entry.hash.slice(0, 7)}\``
}

/** Render the full document, banner included. Ends with exactly one newline. */
export function renderMarkdown(groups: MonthGroup[], meta: RenderMeta): string {
  const command = `bun scripts/emit-changelog.ts${meta.path ? ` --path ${meta.path}` : ''}`
  const target = meta.path ? `${meta.path}/CHANGELOG.md` : 'CHANGELOG.md'
  const lines: string[] = []

  lines.push('<!--')
  lines.push('  GENERATED FILE — do not hand-edit; every edit is lost on the next run.')
  lines.push('  Rendered from git history by scripts/emit-changelog.ts.')
  lines.push('')
  lines.push('  Regenerate (both steps — the generator emits prettier-clean markdown,')
  lines.push('  and the pair is idempotent):')
  lines.push(`    ${command} > ${target}`)
  lines.push(`    bunx prettier --write ${target}`)
  lines.push('')
  lines.push(`  Generated from: ${meta.commit}`)
  lines.push(`  History walked: first-parent of ${meta.ref}`)
  lines.push(`  Scope: ${meta.path ? `commits touching ${meta.path}/` : 'whole repository'}`)
  if (meta.since) lines.push(`  Lower bound: ${meta.since}`)
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
    for (const { type, entries } of group.types) {
      lines.push(`#### ${type}`)
      lines.push('')
      for (const entry of entries) lines.push(renderEntry(entry))
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

/** Minimal hand-rolled flag parsing — no dependency, and there are three flags. */
export function parseArgs(argv: string[]): Options {
  const opts: Options = { ref: 'main' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--ref' || flag === '--path' || flag === '--since') {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`emit-changelog: ${flag} needs a value`)
      }
      if (flag === '--ref') opts.ref = value
      else if (flag === '--path') opts.path = value
      else opts.since = value
      i++
    } else {
      throw new Error(`emit-changelog: unknown argument '${flag}'`)
    }
  }
  return opts
}

function git(args: string[]): string {
  // Args are passed as an array — never interpolated into a shell string.
  const run = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${run.status ?? 'signal'}): ${run.stderr}`)
  }
  return run.stdout
}

/** True when `value` names a commit git can resolve (so it is a ref, not a date). */
function isRef(value: string): boolean {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `${value}^{commit}`], {
      encoding: 'utf8',
    }).status === 0
  )
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const sinceIsRef = opts.since !== undefined && isRef(opts.since)

  const args = [
    'log',
    '--first-parent',
    sinceIsRef ? `${opts.since!}..${opts.ref}` : opts.ref,
    '--pretty=format:%H\x1f%ad\x1f%s',
    '--date=short',
  ]
  if (opts.since !== undefined && !sinceIsRef) args.push(`--since=${opts.since}`)
  if (opts.path !== undefined) args.push('--', opts.path)

  const commits: RawCommit[] = git(args)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, date, ...rest] = line.split('\x1f')
      return { hash, date, subject: rest.join('\x1f') }
    })

  // A shallow checkout (CI, agent containers) has a grafted root: the walk stops
  // there with nothing in the output to say so. Name that commit in the file.
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
  const shallowFrom = shallow ? git(['rev-list', '--max-parents=0', opts.ref]).split('\n')[0] : ''

  const meta: RenderMeta = {
    commit: git(['rev-parse', opts.ref]).trim(),
    ref: opts.ref,
    ...(shallowFrom ? { shallowFrom } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.since !== undefined
      ? { since: sinceIsRef ? `${opts.since} (exclusive)` : `--since=${opts.since}` }
      : {}),
  }

  // Emit to stdout — the caller redirects (see the header).
  process.stdout.write(renderMarkdown(groupCommits(commits), meta))
}

// Bun's main-module flag. The repo has no bun-types, so it is narrowed here
// rather than paying a dependency for one boolean. Importing this module (the
// unit tests do) must never shell out to git.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) main()

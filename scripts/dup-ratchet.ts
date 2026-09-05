#!/usr/bin/env bun
// ═══ Duplication gate — no PR may add a clone that main does not already have ═══
//
//   bun run dup                    CI gate: red on a clone this branch adds over main
//   bun run dup:report [--tests] [--top N] [--min-tokens K] [--type-insensitive]
//                                  the ranked work queue: clone clusters by size × spread
//
// WHAT IT ASSERTS, and why it is a SET DIFFERENCE and not a number. A percentage hides a
// 200-line paste behind a 2000-line feature landing in the same PR (CLAUDE.md §5: gate on
// direction, never on an absolute %). So the gate compares the branch's clone set against
// the clone set of the commit it is measured from, and fails on any pair that is new. The
// ratchet property falls out by construction: main can never GAIN a clone, because no PR
// may add one — no committed number to keep in sync, and no escape hatch.
//
// WHY NOT A COMMITTED FINGERPRINT BASELINE (the first design, reverted 2026-09-05 after CI
// refuted it). jscpd can write its fingerprint set to a file that the gate diffs, which
// gives a visible debt number that only shrinks. It does not survive this repo's merge
// cadence: a fingerprint covers the token stream of a clone PAIR, so ANY commit that edits
// inside ANY of the ~280 baselined regions re-fingerprints it, and the gate then reds on an
// open PR that did nothing. Measured here: main took 4 commits in 19 minutes, one of them
// (#2540) touching `map/src/shaders/dsl/polygon.ts`, and PR #2533's `lint` job went red on
// the merge commit 40 minutes after the baseline was recorded — 2 new + 2 stale, none of
// them this branch's work. At that cadence every open PR pays a merge-and-re-record commit
// per burst, which is a gate that gets bypassed within a week (the same reasoning that
// keeps test duplication out of the gate, applied to the gate itself). `--baseline-from-ref`
// removes the class: nothing is stored, so nothing can go stale.
//
// THE BASE IS THE MERGE BASE WITH `origin/main`, falling back to `origin/main` itself where
// history is shallow — which is the exact answer under CI, whose checkout IS this PR merged
// into main, so "new vs main" is precisely "added by this PR". `resolveBaseRef` fetches
// `main` when the ref is absent and THROWS when it cannot be resolved: a gate that loses its
// base must be red, never quietly green (CLAUDE.md §12, the poller that read a missing key
// as an empty result).
//
// WHY .jscpd.json ROUTES .ts/.tsx THROUGH THE *JAVASCRIPT* TOKENIZER. jscpd 5's TypeScript
// tokenizer (Rust engine, three weeks old at 5.1.2) strips type annotations — which finds
// near-clones that differ only in types — but it has a deterministic blind spot: a whole,
// valid function copied verbatim out of map/src/render/renderer-helpers.ts (`parseColor`,
// 586 tokens) is NOT reported against the full file, while it is against a truncated copy
// of the same file, and it IS reported by the JavaScript tokenizer and by jscpd 4. Measured
// on the whole tree: 29 file-pairs the JS tokenizer finds at 70 tokens that the TS
// tokenizer misses even at 40. A gate's instrument must not have a known false-negative
// mode (CLAUDE.md §12, "validate the instrument against a known positive"), so the gate
// uses the JS tokenizer (30 planted whole-function copies: every one above the token floor
// was flagged). The TS lens stays available for triage: `dup:report --type-insensitive`.
//
// Tests are deliberately outside the gate (they hold ~88% of the duplicated lines). Their
// remedy is different — shared fixture builders, or deleting redundant specs — and a gate
// that fails a new spec for copying an `arrange` block gets bypassed within a week. They
// stay visible: `bun run dup:report --tests`.
//
// The policy this enforces (where a shared helper lives, when the third copy triggers
// consolidation, how an intentional twin is marked) is docs/adr/0013-*.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Detection parameters (minTokens / minLines / mode / format) — the ONE definition of
 *  "what is a clone", shared by the gate and the report so they cannot drift. */
export const CONFIG_FILE = '.jscpd.json'

/** What the gate scans: library src trees, the playground's app code and e2e helpers,
 *  the site's TS, and the repo scripts. Every root must exist — a moved tree would
 *  otherwise leave the gate vacuously green for it (#996). */
export const SCAN_ROOTS: readonly string[] = [
  'shared/src',
  'geo/src',
  'compiler/src',
  'blueprint/src',
  'shader-dsl/src',
  'rhi/src',
  'engine/src',
  'rhi-webgl2/src',
  'rhi-webgpu/src',
  'data/src',
  'map/src',
  'pipeline/src',
  'playground/src',
  'playground/dev',
  'playground/e2e/helpers',
  'site/src',
  'scripts',
]
/** Extra roots only `--report --tests` walks (Playwright specs, DSL example corpus). */
const TEST_ROOTS: readonly string[] = ['playground/e2e', 'shader-dsl/examples']
/** Generated or non-source trees. `__*__` covers fixtures, snapshots, goldens,
 *  __tests__ and __test-support__; `*.generated.ts` is the baked-shader convention. */
export const IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.tsbuild/**',
  '**/*.d.ts',
  '**/*.generated.ts',
  '**/__*__/**',
  'shader-dsl/examples/index.ts',
]
const TEST_IGNORE: readonly string[] = ['**/*.test.ts', '**/*.spec.ts']

// ── Report model ─────────────────────────────────────────────────────────────

export interface Fragment {
  /** Repo-relative, forward slashes. */
  readonly file: string
  readonly start: number
  readonly end: number
}
export interface Clone {
  readonly a: Fragment
  readonly b: Fragment
  readonly lines: number
  readonly tokens: number
  /** Absent from the base ref's clone set — i.e. added by this branch. Meaningful only
   *  when `baseRef` was given; without one jscpd reports `false` for every clone
   *  (measured), so the report mode never reads it. */
  readonly isNew: boolean
}
export interface ScanStats {
  readonly files: number
  readonly lines: number
  readonly clones: number
  readonly duplicatedLines: number
  readonly percentage: number
}
export type CloneClass = 'intra-file' | 'intra-dir' | 'intra-workspace' | 'cross-workspace'

interface JscpdFile {
  name: string
  start: number
  end: number
}
interface JscpdReport {
  duplicates: Array<{
    firstFile: JscpdFile
    secondFile: JscpdFile
    lines: number
    tokens: number
    isNew?: boolean
  }>
  statistics: {
    total: {
      sources: number
      lines: number
      clones: number
      duplicatedLines: number
      percentage: number
    }
  }
}

const slash = (p: string): string => p.split('\\').join('/')

export function parseReport(
  report: JscpdReport,
  root: string,
): { clones: Clone[]; stats: ScanStats } {
  const frag = (f: JscpdFile): Fragment => ({
    file: slash(relative(root, f.name)),
    start: f.start,
    end: f.end,
  })
  const clones = report.duplicates.map((d) => ({
    a: frag(d.firstFile),
    b: frag(d.secondFile),
    lines: d.lines,
    tokens: d.tokens,
    isNew: d.isNew ?? true,
  }))
  const t = report.statistics.total
  return {
    clones,
    stats: {
      files: t.sources,
      lines: t.lines,
      clones: t.clones,
      duplicatedLines: t.duplicatedLines,
      percentage: t.percentage,
    },
  }
}

/** The npm workspace a repo-relative path belongs to (its first segment). */
export const workspaceOf = (file: string): string => file.split('/')[0]!
const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'))

export function classify(c: Clone): CloneClass {
  if (c.a.file === c.b.file) return 'intra-file'
  if (dirOf(c.a.file) === dirOf(c.b.file)) return 'intra-dir'
  if (workspaceOf(c.a.file) === workspaceOf(c.b.file)) return 'intra-workspace'
  return 'cross-workspace'
}

export interface Cluster {
  /** Distinct fragments (copies) in the cluster. */
  readonly copies: number
  readonly clones: number
  /** Sum of clone-pair lengths — grows with size AND spread, which is the ranking. */
  readonly dupLines: number
  readonly maxTokens: number
  /** file → its ranges, insertion-ordered by first appearance. */
  readonly files: ReadonlyMap<string, readonly string[]>
}

/** Group clone pairs into clusters: two fragments join when a pair links them or when
 *  they overlap in the same file. A helper copied five times is ONE cluster of five, not
 *  ten pairs — the count that decides whether the rule of three has fired. */
export function clusterClones(clones: readonly Clone[]): Cluster[] {
  const frags: Array<Fragment & { clone: Clone }> = []
  for (const c of clones) frags.push({ ...c.a, clone: c }, { ...c.b, clone: c })
  const parent = frags.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const union = (i: number, j: number): void => {
    parent[find(i)] = find(j)
  }
  for (let i = 0; i < frags.length; i += 2) union(i, i + 1)
  const byFile = new Map<string, number[]>()
  frags.forEach((f, i) => byFile.set(f.file, [...(byFile.get(f.file) ?? []), i]))
  for (const idx of byFile.values())
    for (let i = 0; i < idx.length; i++)
      for (let j = i + 1; j < idx.length; j++) {
        const a = frags[idx[i]!]!
        const b = frags[idx[j]!]!
        if (a.start <= b.end && b.start <= a.end) union(idx[i]!, idx[j]!)
      }
  const groups = new Map<number, Array<Fragment & { clone: Clone }>>()
  frags.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]))
  const out: Cluster[] = []
  for (const members of groups.values()) {
    const files = new Map<string, string[]>()
    const seen = new Set<string>()
    const pairs = new Set<Clone>()
    let maxTokens = 0
    for (const m of members) {
      const key = `${m.file}:${m.start}-${m.end}`
      if (!seen.has(key)) {
        seen.add(key)
        files.set(m.file, [...(files.get(m.file) ?? []), `${m.start}-${m.end}`])
      }
      pairs.add(m.clone)
      maxTokens = Math.max(maxTokens, m.clone.tokens)
    }
    let dupLines = 0
    for (const p of pairs) dupLines += p.lines
    out.push({ copies: seen.size, clones: pairs.size, dupLines, maxTokens, files })
  }
  return out.sort((x, y) => y.dupLines - x.dupLines)
}

export const formatClone = (c: Clone): string =>
  `${c.a.file}:${c.a.start}-${c.a.end}  ~  ${c.b.file}:${c.b.start}-${c.b.end}  ` +
  `(${c.lines} lines, ${c.tokens} tokens) [${classify(c)}]`

// ── Intentional-twin markers ────────────────────────────────────────────────
//
// jscpd honours `// jscpd:ignore-start` … `// jscpd:ignore-end`. A marker is the record
// of a DELIBERATE twin (e.g. a WebGL2/WebGPU pair kept apart on purpose), so it carries
// its reason on the same line — a bare marker is the eslint-disable-without-a-reason of
// duplication, and the gate rejects it.

const MARKER = /jscpd:ignore-start(.*)$/

export function bareMarkers(files: Iterable<[file: string, text: string]>): string[] {
  const out: string[] = []
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      const m = MARKER.exec(line)
      if (m && m[1]!.replace(/^[\s—:-]+/, '').trim().length === 0) out.push(`${file}:${i + 1}`)
    })
  }
  return out
}

function* walkSources(root: string, rel: string): Generator<[string, string]> {
  const abs = join(root, rel)
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(abs, name)
    if (statSync(p).isDirectory()) yield* walkSources(root, `${rel}/${name}`)
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield [`${rel}/${name}`, readFileSync(p, 'utf8')]
  }
}

// ── Running jscpd ────────────────────────────────────────────────────────────

export interface ScanOptions {
  readonly root: string
  readonly roots: readonly string[]
  readonly ignore: readonly string[]
  /** Compare against this git ref's tree: clones absent from it are reported `isNew`.
   *  Nothing is written — the comparison baseline is built from the ref on each run. */
  readonly baseRef?: string
  readonly minTokens?: number
  /** Report-only lens: jscpd's TypeScript tokenizer (type-annotation-insensitive, with the
   *  known blind spot described in the header). Never used by the gate. */
  readonly typeInsensitive?: boolean
}

/** Run the jscpd binary through its own launcher (`jscpd/run-jscpd.js` picks the
 *  platform package), with the committed detection config plus the given scan set.
 *  Reports are written to a fresh temp dir and read back as JSON. */
export function scan(opts: ScanOptions): { clones: Clone[]; stats: ScanStats; reportPath: string } {
  const require = createRequire(import.meta.url)
  const launcher = require.resolve('jscpd/run-jscpd.js')
  const outDir = mkdtempSync(join(tmpdir(), 'jscpd-'))
  const args = [
    launcher,
    '--config',
    join(REPO_ROOT, CONFIG_FILE),
    '--absolute',
    '--reporters',
    'json,silent',
    '--output',
    outDir,
    '--ignore',
    opts.ignore.join(','),
  ]
  if (opts.minTokens !== undefined) args.push('--min-tokens', String(opts.minTokens))
  if (opts.typeInsensitive)
    args.push(
      '--format',
      'typescript,tsx,javascript',
      '--formats-exts',
      'typescript:ts;tsx:tsx;javascript:js,mjs',
    )
  if (opts.baseRef) args.push('--baseline-from-ref', opts.baseRef)
  args.push(...opts.roots)
  const r = spawnSync(process.execPath, args, { cwd: opts.root, encoding: 'utf8' })
  const reportPath = join(outDir, 'jscpd-report.json')
  if (!existsSync(reportPath)) {
    throw new Error(
      `jscpd produced no report (exit ${r.status})\n${r.stdout ?? ''}${r.stderr ?? ''}`,
    )
  }
  const parsed = parseReport(JSON.parse(readFileSync(reportPath, 'utf8')) as JscpdReport, opts.root)
  return { ...parsed, reportPath }
}

/** The commit this branch is measured against.
 *
 *  MERGE BASE with `origin/main` where the history is there; `origin/main` itself where it
 *  is not — CI checks out at depth 1, and there the checkout IS the PR merged into main, so
 *  main's tip is the correct and exact base. Fetches `main` shallowly when the ref is
 *  missing. THROWS rather than returning undefined: `scan` without a `baseRef` marks every
 *  clone new, so a silent failure here would turn the gate from "added by this branch" into
 *  "every clone in the repo" — loud is the only safe direction (CLAUDE.md §12). */
export function resolveBaseRef(root: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const has = (ref: string): boolean => {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
      return true
    } catch {
      return false
    }
  }
  if (!has('origin/main')) {
    try {
      // Explicit refspec: `actions/checkout` configures `remote.origin.fetch` for the
      // checked-out ref ONLY, so a bare `fetch origin main` can leave `origin/main`
      // unresolvable and the gate blind. --depth=1 is enough — only main's TREE is read.
      git('fetch', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    } catch {
      /* reported by the throw below */
    }
  }
  if (!has('origin/main')) {
    throw new Error(
      'dup: cannot resolve `origin/main` — the gate has no base to compare against.\n' +
        '  In CI add `git fetch --depth=1 origin main` before this step; locally run it once.',
    )
  }
  try {
    return git('merge-base', 'HEAD', 'origin/main')
  } catch {
    return 'origin/main' // shallow history: main's tip is the base CI actually wants
  }
}

// ── Modes ────────────────────────────────────────────────────────────────────

const POLICY = 'docs/adr/0013-duplication-ratchet-and-consolidation.md'

function assertRoots(root: string, roots: readonly string[]): void {
  const missing = roots.filter((r) => !existsSync(join(root, r)))
  if (missing.length) {
    console.error(
      `dup: scan root(s) missing — moved or deleted? Update SCAN_ROOTS:\n  ${missing.join('\n  ')}`,
    )
    process.exit(2)
  }
}

function summary(stats: ScanStats, extra = ''): string {
  return (
    `jscpd: ${stats.clones} clones, ${stats.duplicatedLines} duplicated lines ` +
    `(${stats.percentage.toFixed(2)}%) across ${stats.files} files / ${stats.lines} lines${extra}`
  )
}

/** `bun run dup` — the gate. */
function check(root: string): number {
  assertRoots(root, SCAN_ROOTS)
  const baseRef = resolveBaseRef(root)
  const { clones, stats } = scan({
    root,
    roots: SCAN_ROOTS,
    ignore: [...IGNORE, ...TEST_IGNORE],
    baseRef,
  })
  const fresh = clones.filter((c) => c.isNew)
  const bare = bareMarkers(SCAN_ROOTS.flatMap((r) => [...walkSources(root, r)]))
  console.log(summary(stats, `; base ${baseRef.slice(0, 12)}`))

  let red = false
  if (fresh.length) {
    red = true
    console.error(`\n✗ ${fresh.length} clone(s) this branch adds over its base:`)
    for (const c of fresh) console.error(`  ${formatClone(c)}`)
    console.error(
      `\n  A new copy — including a THIRD copy of a pair the base already has — is the moment\n` +
        `  to extract the shared helper (${POLICY}). If the twin is\n` +
        `  deliberate, mark it \`// jscpd:ignore-start — <reason>\` … \`// jscpd:ignore-end\`.`,
    )
  }
  if (bare.length) {
    red = true
    console.error(
      `\n✗ jscpd:ignore-start without a reason on the same line:\n  ${bare.join('\n  ')}`,
    )
  }
  if (!red) console.log('✓ duplication gate: this branch adds no clone its base lacks')
  return red ? 1 : 0
}

/** `bun run dup:report [--tests] [--top N] [--min-tokens K] [--type-insensitive]` — the
 *  work queue. */
function report(
  root: string,
  opts: { tests: boolean; top: number; minTokens?: number; typeInsensitive: boolean },
): number {
  const roots = opts.tests ? [...SCAN_ROOTS, ...TEST_ROOTS] : SCAN_ROOTS
  assertRoots(root, roots)
  const { clones, stats, reportPath } = scan({
    root,
    roots,
    ignore: opts.tests ? IGNORE : [...IGNORE, ...TEST_IGNORE],
    minTokens: opts.minTokens,
    typeInsensitive: opts.typeInsensitive,
  })
  console.log(
    summary(
      stats,
      (opts.tests ? ' (tests included' : ' (tests excluded') +
        (opts.typeInsensitive ? '; TypeScript tokenizer lens)' : ')'),
    ),
  )
  const top = opts.top

  const byClass = new Map<CloneClass, Clone[]>()
  for (const c of clones) byClass.set(classify(c), [...(byClass.get(classify(c)) ?? []), c])
  console.log('\n## by class (remedy differs per class — see the ADR)')
  for (const k of ['intra-file', 'intra-dir', 'intra-workspace', 'cross-workspace'] as const) {
    const v = byClass.get(k) ?? []
    const lines = v.reduce((s, c) => s + c.lines, 0)
    console.log(`  ${k.padEnd(16)} clones=${String(v.length).padStart(5)}  dupLines=${lines}`)
  }

  const perWs = new Map<string, { frags: number; lines: number }>()
  for (const c of clones)
    for (const f of [c.a, c.b]) {
      const e = perWs.get(workspaceOf(f.file)) ?? { frags: 0, lines: 0 }
      perWs.set(workspaceOf(f.file), { frags: e.frags + 1, lines: e.lines + c.lines })
    }
  console.log('\n## fragments per workspace (both sides of a pair counted)')
  for (const [ws, e] of [...perWs].sort((x, y) => y[1].lines - x[1].lines))
    console.log(`  ${ws.padEnd(14)} frags=${String(e.frags).padStart(5)}  lines=${e.lines}`)

  const cross = byClass.get('cross-workspace') ?? []
  if (cross.length) {
    console.log('\n## cross-workspace pairs (candidates for shared/ or the lower package)')
    const pairs = new Map<string, { n: number; lines: number }>()
    for (const c of cross) {
      const k = [workspaceOf(c.a.file), workspaceOf(c.b.file)].sort().join(' <-> ')
      const e = pairs.get(k) ?? { n: 0, lines: 0 }
      pairs.set(k, { n: e.n + 1, lines: e.lines + c.lines })
    }
    for (const [k, e] of [...pairs].sort((x, y) => y[1].lines - x[1].lines))
      console.log(`  ${k.padEnd(30)} clones=${String(e.n).padStart(3)}  lines=${e.lines}`)
  }

  const clusters = clusterClones(clones)
  console.log(
    `\n## ${clusters.length} clusters (${clusters.filter((c) => c.copies >= 3).length} with ≥3 copies) — top ${top} by duplicated lines`,
  )
  for (const c of clusters.slice(0, top)) {
    const ws = [...new Set([...c.files.keys()].map(workspaceOf))].join(',')
    console.log(
      `\n- dupLines=${c.dupLines} copies=${c.copies} files=${c.files.size} maxTokens=${c.maxTokens} ws=[${ws}]`,
    )
    for (const [file, ranges] of c.files) console.log(`    ${file}  [${ranges.join(', ')}]`)
  }
  console.log(`\nraw jscpd JSON: ${reportPath}`)
  return 0
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  let code: number
  if (argv.includes('--report')) {
    const mt = flag('--min-tokens')
    code = report(REPO_ROOT, {
      tests: argv.includes('--tests'),
      top: Number(flag('--top') ?? 30),
      minTokens: mt === undefined ? undefined : Number(mt),
      typeInsensitive: argv.includes('--type-insensitive'),
    })
  } else {
    code = check(REPO_ROOT)
  }
  process.exit(code)
}

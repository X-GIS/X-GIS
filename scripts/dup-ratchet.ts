#!/usr/bin/env bun
// ═══ Duplication ratchet — a jscpd fingerprint baseline that can only shrink ═══
//
//   bun run dup                    CI gate: red on a NEW clone or a STALE baseline entry
//   bun run dup:accept             rewrite .jscpd-baseline.json (shrink freely; growth
//                                  needs --allow-growth, and the PR must say why)
//   bun run dup:report [--tests] [--top N] [--min-tokens K] [--type-insensitive]
//                                  the ranked work queue: clone clusters by size × spread
//
// MEASURED 2026-09-05 on this tree (~900 source files, 231k lines; tests excluded), with
// the tokenizer .jscpd.json selects (see below):
//
//   minTokens 50 / minLines 5 → see the ADR's table
//   minTokens 70 / minLines 5 → the gate (the ADR records the count at baseline time)
//   with tests (2.5k files, 527k lines): ~5× the duplicated lines — `--tests` shows them
//
// The gate does NOT assert a percentage — a ratio hides a 200-line paste behind a 2000-
// line feature landing in the same PR (CLAUDE.md §5: gate on direction, never on an
// absolute %). It asserts the SET of clones: jscpd fingerprints every clone pair by its
// token stream, so a fingerprint survives moving lines, renaming the file, or editing
// unrelated code (all three probed), and a NEW fingerprint is a new copy — including the
// THIRD copy of something already baselined, which is exactly the "rule of three" moment
// (probed: a third copy of a baselined pair is reported as new).
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
// Shrink-only, like map/src/loc-ceiling-ratchet.test.ts and the dependency-direction
// ratchet: a fingerprint that no longer matches any clone must leave the baseline in the
// same commit (`bun run dup:accept`). That is the #996 lesson — a baseline that outlives
// its subject is a number that stopped meaning "current debt".
//
// Tests are deliberately outside the gate (they hold ~88% of the duplicated lines). Their
// remedy is different — shared fixture builders, or deleting redundant specs — and a gate
// that fails a new spec for copying an `arrange` block gets bypassed within a week. They
// stay visible: `bun run dup:report --tests`.
//
// The policy this enforces (where a shared helper lives, when the third copy triggers
// consolidation, how an intentional twin is marked) is docs/adr/0013-*.md.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Detection parameters (minTokens / minLines / mode / format) — the ONE definition of
 *  "what is a clone", shared by the gate and the report so they cannot drift. */
export const CONFIG_FILE = '.jscpd.json'
export const BASELINE_FILE = '.jscpd-baseline.json'

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
  /** Not in the baseline handed to jscpd. Meaningful only when one was given — without a
   *  baseline jscpd reports `false` for every clone (measured), so the report mode never
   *  reads it. */
  readonly isNew: boolean
}
export interface ScanStats {
  readonly files: number
  readonly lines: number
  readonly clones: number
  readonly duplicatedLines: number
  readonly percentage: number
}
export interface Baseline {
  readonly version: number
  readonly fingerprints: Readonly<Record<string, number>>
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

/** Fingerprints that entered (new clones) and left (stale entries) between two baselines. */
export function diffBaseline(
  committed: Baseline,
  current: Baseline,
): { added: string[]; removed: string[] } {
  const was = new Set(Object.keys(committed.fingerprints))
  const now = new Set(Object.keys(current.fingerprints))
  return {
    added: [...now].filter((k) => !was.has(k)).sort(),
    removed: [...was].filter((k) => !now.has(k)).sort(),
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
  /** A baseline file to compare against; with `updateBaseline` it is REWRITTEN in place. */
  readonly baseline?: string
  readonly updateBaseline?: boolean
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
  if (opts.baseline) args.push('--baseline', opts.baseline)
  if (opts.updateBaseline) args.push('--update-baseline')
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

const readBaseline = (p: string): Baseline => JSON.parse(readFileSync(p, 'utf8')) as Baseline

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
  const committedPath = join(root, BASELINE_FILE)
  if (!existsSync(committedPath)) {
    console.error(`dup: ${BASELINE_FILE} missing — create it once with \`bun run dup:accept\``)
    return 2
  }
  const committed = readBaseline(committedPath)
  const tmp = join(mkdtempSync(join(tmpdir(), 'jscpd-base-')), BASELINE_FILE)
  copyFileSync(committedPath, tmp)
  const { clones, stats } = scan({
    root,
    roots: SCAN_ROOTS,
    ignore: [...IGNORE, ...TEST_IGNORE],
    baseline: tmp,
    updateBaseline: true,
  })
  const { removed } = diffBaseline(committed, readBaseline(tmp))
  const fresh = clones.filter((c) => c.isNew)
  const bare = bareMarkers(SCAN_ROOTS.flatMap((r) => [...walkSources(root, r)]))
  console.log(
    summary(stats, `; baseline ${Object.keys(committed.fingerprints).length} fingerprints`),
  )

  let red = false
  if (fresh.length) {
    red = true
    console.error(`\n✗ ${fresh.length} NEW clone(s) not in ${BASELINE_FILE}:`)
    for (const c of fresh) console.error(`  ${formatClone(c)}`)
    console.error(
      `\n  A new copy — including a THIRD copy of an existing pair — is the moment to extract\n` +
        `  the shared helper (${POLICY}). If the twin is deliberate, mark it\n` +
        `  \`// jscpd:ignore-start — <reason>\` … \`// jscpd:ignore-end\`. If you only edited an\n` +
        `  EXISTING copy in place, its fingerprint moved: \`bun run dup:accept\` re-records it\n` +
        `  (the count may not grow). Accepting new debt is \`--allow-growth\` plus a reason in the PR.`,
    )
  }
  if (removed.length) {
    red = true
    console.error(
      `\n✗ ${removed.length} STALE fingerprint(s) in ${BASELINE_FILE} match no clone any more.\n` +
        `  The debt shrank — record it in this same commit: \`bun run dup:accept\`.`,
    )
  }
  if (bare.length) {
    red = true
    console.error(
      `\n✗ jscpd:ignore-start without a reason on the same line:\n  ${bare.join('\n  ')}`,
    )
  }
  if (!red) console.log('✓ duplication ratchet: no new clones, baseline current')
  return red ? 1 : 0
}

/** `bun run dup:accept [--allow-growth]` — rewrite the baseline from the tree. */
function accept(root: string, allowGrowth: boolean): number {
  assertRoots(root, SCAN_ROOTS)
  const committedPath = join(root, BASELINE_FILE)
  const first = !existsSync(committedPath)
  const committed: Baseline = first ? { version: 1, fingerprints: {} } : readBaseline(committedPath)
  const tmp = join(mkdtempSync(join(tmpdir(), 'jscpd-base-')), BASELINE_FILE)
  if (!first) copyFileSync(committedPath, tmp)
  const { clones, stats } = scan({
    root,
    roots: SCAN_ROOTS,
    ignore: [...IGNORE, ...TEST_IGNORE],
    baseline: tmp,
    updateBaseline: true,
  })
  const current = readBaseline(tmp)
  const { added, removed } = diffBaseline(committed, current)
  const fresh = clones.filter((x) => x.isNew)
  console.log(summary(stats))
  // The ratchet is on the COUNT. Editing inside an existing copy moves its fingerprint
  // (+1 −1, net 0) and must not need a flag; a third copy is +1 −0 and does.
  if (added.length > removed.length && !first && !allowGrowth) {
    console.error(
      `\n✗ refusing to grow ${BASELINE_FILE}: +${added.length} −${removed.length} fingerprints. New clones:`,
    )
    for (const c of fresh) console.error(`  ${formatClone(c)}`)
    console.error(`\n  Extract the helper, or re-run with --allow-growth and justify it in the PR.`)
    return 1
  }
  copyFileSync(tmp, committedPath)
  console.log(
    `✓ ${BASELINE_FILE} ${first ? 'created' : 'updated'}: +${added.length} −${removed.length} ` +
      `(${Object.keys(current.fingerprints).length} fingerprints)`,
  )
  if (fresh.length && !first) {
    console.log(
      `  re-fingerprinted / accepted clones (a \`+\` line in the baseline diff is a review question):`,
    )
    for (const c of fresh) console.log(`  ${formatClone(c)}`)
  }
  return 0
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
  } else if (argv.includes('--accept')) {
    code = accept(REPO_ROOT, argv.includes('--allow-growth'))
  } else {
    code = check(REPO_ROOT)
  }
  process.exit(code)
}

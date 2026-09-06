#!/usr/bin/env bun
// ═══ Duplication gate — no PR may add a clone that main does not already have ═══
//
//   bun run dup                    CI gate: red on a clone this branch adds over main
//   bun run dup:report [--tests] [--top N] [--min-tokens K] [--type-insensitive]
//                                  the ranked work queue: clone clusters by size × spread
//   bun run dup:report --shape     the Type-2 lens: clones whose identifiers differ, which
//                                  the token gate cannot see (report only — see below)
//
// WHAT IT ASSERTS, and why it is DIRECTIONAL and not a number. A percentage hides a
// 200-line paste behind a 2000-line feature landing in the same PR (CLAUDE.md §5: gate on
// direction, never on an absolute %). So the gate measures, per unordered FILE PAIR, how
// many duplicated tokens the branch has and how many its base had, and fails on a pair that
// GREW. The ratchet property falls out by construction: main can never gain duplication
// between two files, because no PR may add any — no committed number to keep in sync, and
// no escape hatch.
//
// WHY THE PAIR TOKEN TOTAL AND NOT jscpd's PER-CLONE `isNew` ALONE (#2570). `isNew` keys on
// the token-stream fingerprint of a clone PAIR, so a clone whose extent SHRINKS has a stream
// the base's set does not contain and is reported new — the gate then reds on the branch that
// REMOVED the duplication. Measured on #2560: five clones / 588 tokens between
// `raster-renderer.ts` and `hillshade-renderer.ts` became four / 412, and the gate called it
// a regression. Line-interval containment cannot fix it — the two sides sit in DIFFERENT
// revisions of the same file, so `590-602 ⊃ 590-599` on one side and `854-866 ⊅ 858-867` on
// the other, from one edit. The pair total has no such problem: it is a quantity, comparable
// across revisions, and it moves in the direction the gate actually cares about. `isNew`
// still narrows WHICH clone of a grown pair is named, so the message stays specific.
//
// WHAT THIS DELIBERATELY DOES NOT CATCH, stated because a blind spot nobody wrote down reads
// as clean (CLAUDE.md §14, Type-4): a NEW clone region between two files that ALREADY
// duplicate each other, in a branch that simultaneously removes at least as many duplicated
// tokens between those same two files. Net duplication between the pair went down, which is
// not the direction ADR-0013 blocks. The rule-of-three case it is built for is unaffected: a
// third copy always lands in some file, and every pair that file forms is a pair the base has
// zero tokens for — a new pair is growth from 0, so it reds.
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
// THE BASE IS THE MERGE BASE WITH `origin/main` — always, with no fallback: main's tip is a
// commit the branch has not merged, and comparing against it reported untouched files as
// newly duplicated (#2597). `resolveBaseRef` fetches `main` when the ref is absent, deepens
// once when the checkout is too shallow for a merge base, and THROWS when neither works: a
// gate that loses its base must be red, never quietly green (CLAUDE.md §12, the poller that
// read a missing key as an empty result).
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/** Materialise `ref`'s tree and scan it with the SAME configuration as the head scan, so
 *  the two clone sets are comparable. Only the scan roots the ref actually has are asked
 *  for — a root this branch adds does not exist there, and `git archive` errors on it. */
export function scanRef(
  root: string,
  ref: string,
  roots: readonly string[],
  ignore: readonly string[],
): Clone[] {
  const present = roots.filter((r) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${r}`], { cwd: root, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  if (present.length === 0) return []
  // realpath, because `parseReport` relativises jscpd's ABSOLUTE paths against this root:
  // where the temp dir is reached through a symlink the two spellings differ, `relative()`
  // escapes with `..`, and every pair key misses — which silently empties the base set and
  // restores the very behaviour this function exists to replace. Asserted below as well.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jscpd-base-')))
  const tar = execFileSync('git', ['archive', '--format=tar', ref, '--', ...present], {
    cwd: root,
    maxBuffer: 1 << 30,
  })
  execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 30 })
  const clones = scan({ root: dir, roots: present, ignore }).clones
  const escaped = clones.find((c) => c.a.file.startsWith('..') || c.a.file.startsWith('/'))
  if (escaped) {
    throw new Error(
      `dup: the base scan's paths did not relativise (${escaped.a.file}) — the comparison\n` +
        '  would be empty and every clone would look new. Report this with the path above.',
    )
  }
  return clones
}

/** Unordered — jscpd may report a pair in either order, and (a,b) is one relationship. */
export const pairKey = (c: Clone): string => [c.a.file, c.b.file].sort().join('\u0000')

/** Duplicated tokens per unordered file pair. The gate's directional quantity: it is
 *  comparable across revisions, which a line interval is not (see the header, #2570). */
export function tokensByPair(clones: readonly Clone[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of clones) m.set(pairKey(c), (m.get(pairKey(c)) ?? 0) + c.tokens)
  return m
}

/** The clones the branch is accountable for: those jscpd flags as absent from the base AND
 *  whose file pair carries more duplicated tokens here than it did on the base. A pair the
 *  base does not have at all counts from 0, so a genuinely new copy still reds. */
export function addedClones(head: readonly Clone[], base: readonly Clone[]): Clone[] {
  const before = tokensByPair(base)
  const after = tokensByPair(head)
  return head.filter((c) => c.isNew && (after.get(pairKey(c)) ?? 0) > (before.get(pairKey(c)) ?? 0))
}

// ── The SHAPE lens (Type-2) ──────────────────────────────────────────────────
//
// The gate compares TOKEN streams, so a copy whose identifiers were renamed is invisible
// to it — and in this repo that is the majority of the duplication, because the sibling
// families differ in exactly the names that say which primitive they serve. Measured
// 2026-09-05 at 6c2fdfd, both passes summed per pair so the units match: 279 token pairs /
// 3673 lines, against 241 FURTHER pairs / 3831 lines that only appear once identifiers are
// erased — so the gate sees ~49% of the duplicated lines. A further 86 shape pairs EXTEND
// a pair the gate already flags rather than adding one; they are the same finding, larger,
// and are counted separately for exactly that reason. See `shapeOnlyClones`.
//
// Method: re-emit every file with TypeScript's own scanner, replacing each identifier with
// `_` and each string/number literal with a constant, blanking comment TEXT but keeping its
// newlines so a hit still maps to the original line. Run the same detector on that tree and
// subtract every pair whose range the token pass already covers (by OVERLAP — see
// `shapeOnlyClones` for why an equal-start key is wrong).
//
// REPORT ONLY, never a gate. Two noise classes dominate the raw output and both are
// legitimate code: a uniform list matching ITSELF shifted by one entry (a 270-row colour
// table where every row shapes to `_: "S",`), and data tables generally. They are filtered
// below by construction — self-overlap, and a distinct-line ratio floor — but the filters
// are heuristics, and gating on a heuristic that calls a colour table "duplication" is how
// a gate gets bypassed (ADR-0013 alternative 8 is the same lesson, already paid for).

/** Distinct non-blank lines / total, over a fragment. A hand-written function scores high;
 *  a data table scores near zero because every row shapes to the same text. */
function lineDiversity(text: string, start: number, end: number): number {
  const rows = text
    .split('\n')
    .slice(start - 1, end)
    .map((l) => l.trim())
    .filter(Boolean)
  return rows.length === 0 ? 1 : new Set(rows).size / rows.length
}

/** True when a clone is a region matching itself a few entries along — a list, not a copy. */
const selfOverlapping = (c: Clone): boolean =>
  c.a.file === c.b.file && c.a.start <= c.b.end && c.b.start <= c.a.end

/** Write a structure-only mirror of `roots` into a fresh temp tree; returns its path. */
function writeShapeTree(root: string, roots: readonly string[]): string {
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')
  const out = mkdtempSync(join(tmpdir(), 'jscpd-shape-'))
  for (const r of roots)
    for (const [rel, src] of walkSources(root, r)) {
      if (!/\.tsx?$/.test(rel) || TEST_IGNORE.some((g) => rel.endsWith(g.replace('**/*', ''))))
        continue
      const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, src)
      let shaped = ''
      for (;;) {
        const k = sc.scan()
        if (k === ts.SyntaxKind.EndOfFileToken) break
        const t = sc.getTokenText()
        if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) shaped += '_'
        else if (
          k === ts.SyntaxKind.StringLiteral ||
          k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
        )
          shaped += '"S"'
        else if (k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.BigIntLiteral)
          shaped += '0'
        else if (
          k === ts.SyntaxKind.SingleLineCommentTrivia ||
          k === ts.SyntaxKind.MultiLineCommentTrivia
        )
          shaped += t.replace(/[^\n]/g, ' ') // keep the line count, drop the words
        else shaped += t
      }
      const dst = join(out, rel)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, shaped)
    }
  return out
}

/** Clones that appear only once identifiers are erased, with the two noise classes removed.
 *
 *  The subtraction is by RANGE OVERLAP, not by equal start line, and the difference is not
 *  cosmetic: erasing identifiers changes the token stream, so jscpd re-anchors a match a few
 *  lines either way and the SAME finding comes back with a different start. Keying on the
 *  start let 54 clones / 1276 lines — a quarter of the reported total — through as
 *  "invisible to the gate" when the gate had already flagged that very file pair. Measured
 *  2026-09-05 against both raw reports; the honest shape-only figure is ~240 / ~3830. */
export function shapeOnlyClones(
  shaped: readonly Clone[],
  token: readonly Clone[],
  readShaped: (file: string) => string,
  minDiversity = 0.5,
): Clone[] {
  // jscpd's file ORDER inside a pair is not canonical: it emits both (a,b) and (b,a) for
  // different fragments of one file pair — 60 such pairs in the token pass alone, measured
  // 2026-09-05. The two passes do agree today (0 flips), but a subtraction that rests on
  // that agreement would silently under-subtract the day a version bump changes it, so each
  // token span is indexed under BOTH orientations.
  const byPair = new Map<string, Array<readonly [number, number, number, number]>>()
  const index = (k: string, span: readonly [number, number, number, number]): void => {
    const at = byPair.get(k)
    if (at === undefined) byPair.set(k, [span])
    else at.push(span)
  }
  for (const t of token) {
    index(`${t.a.file}|${t.b.file}`, [t.a.start, t.a.end, t.b.start, t.b.end])
    index(`${t.b.file}|${t.a.file}`, [t.b.start, t.b.end, t.a.start, t.a.end])
  }
  const alreadyGated = (c: Clone): boolean =>
    (byPair.get(`${c.a.file}|${c.b.file}`) ?? []).some(
      ([as, ae, bs, be]) => c.a.start <= ae && as <= c.a.end && c.b.start <= be && bs <= c.b.end,
    )

  return shaped.filter((c) => {
    if (alreadyGated(c)) return false
    if (selfOverlapping(c)) return false
    const d = Math.min(
      lineDiversity(readShaped(c.a.file), c.a.start, c.a.end),
      lineDiversity(readShaped(c.b.file), c.b.start, c.b.end),
    )
    return d >= minDiversity
  })
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
    /* shallow checkout — deepen once below rather than guessing a base */
  }
  // A shallow clone hides the common ancestor, and there is no safe guess. Falling back to
  // main's TIP (what this did until 2026-09-06) compares the branch against a commit it has
  // not merged, so any commit that re-anchors a clone reports untouched files as newly
  // duplicated: PR #2593 (a shader-dsl change, zero files under map/) was reddened by a
  // hillshade/raster-renderer pair that already existed on main, and #2591 by six more.
  try {
    git('fetch', '--deepen=250', 'origin', 'main')
    return git('merge-base', 'HEAD', 'origin/main')
  } catch {
    throw new Error(
      'dup: no merge base with `origin/main` — the checkout is too shallow, and this gate\n' +
        "  must NOT fall back to main's tip: the branch has not merged it, so a commit that\n" +
        '  re-anchors a clone would report untouched files as newly duplicated.\n' +
        '  In CI, check out with `fetch-depth: 0`; locally, unshallow the clone.',
    )
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
  // NaN percentage = a filtered subset (the shape lens); a ratio over it would be a lie.
  const pct = Number.isFinite(stats.percentage) ? ` (${stats.percentage.toFixed(2)}%)` : ''
  return (
    `jscpd: ${stats.clones} clones, ${stats.duplicatedLines} duplicated lines${pct} ` +
    `across ${stats.files} files / ${stats.lines} lines${extra}`
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
  // jscpd's `isNew` alone reds a branch that SHRANK a clone (#2570), so it is only the
  // first filter. The verdict is the pair's token total, which needs the base's clone set —
  // a second scan, taken LAZILY: a run with nothing flagged is already green and pays
  // nothing for the disambiguation.
  const flagged = clones.filter((c) => c.isNew)
  const baseClones = flagged.length
    ? scanRef(root, baseRef, SCAN_ROOTS, [...IGNORE, ...TEST_IGNORE])
    : []
  const fresh = addedClones(clones, baseClones)
  const before = tokensByPair(baseClones)
  const after = tokensByPair(clones)
  const bare = bareMarkers(SCAN_ROOTS.flatMap((r) => [...walkSources(root, r)]))
  console.log(summary(stats, `; base ${baseRef.slice(0, 12)}`))
  if (flagged.length && !fresh.length) {
    console.log(
      `✓ ${flagged.length} clone(s) re-fingerprinted (shifted or shortened), no file pair grew`,
    )
  }

  let red = false
  if (fresh.length) {
    red = true
    console.error(`\n✗ ${fresh.length} clone(s) this branch adds over its base:`)
    for (const c of fresh) {
      const k = pairKey(c)
      console.error(`  ${formatClone(c)}`)
      console.error(`      pair total: ${before.get(k) ?? 0} → ${after.get(k) ?? 0} tokens`)
    }
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

/** `bun run dup:report [--tests] [--shape] [--top N] [--min-tokens K] [--type-insensitive]`
 *  — the work queue. */
function report(
  root: string,
  opts: {
    tests: boolean
    top: number
    minTokens?: number
    typeInsensitive: boolean
    shape: boolean
  },
): number {
  const roots = opts.tests ? [...SCAN_ROOTS, ...TEST_ROOTS] : SCAN_ROOTS
  assertRoots(root, roots)
  const ignore = opts.tests ? IGNORE : [...IGNORE, ...TEST_IGNORE]
  let { clones, stats, reportPath } = scan({
    root,
    roots,
    ignore,
    minTokens: opts.minTokens,
    typeInsensitive: opts.typeInsensitive,
  })
  let lens =
    (opts.tests ? ' (tests included' : ' (tests excluded') +
    (opts.typeInsensitive ? '; TypeScript tokenizer lens)' : ')')

  if (opts.shape) {
    // Structure-only mirror, minus everything the token pass above already reports.
    const shapeRoot = writeShapeTree(root, roots)
    const shaped = scan({ root: shapeRoot, roots: ['.'], ignore, minTokens: opts.minTokens })
    const cache = new Map<string, string>()
    const readShaped = (f: string): string => {
      let t = cache.get(f)
      if (t === undefined) {
        t = readFileSync(join(shapeRoot, f), 'utf8')
        cache.set(f, t)
      }
      return t
    }
    const only = shapeOnlyClones(shaped.clones, clones, readShaped)
    // Compare the two passes in the SAME unit. `stats.duplicatedLines` is jscpd's own
    // figure, which de-duplicates overlapping fragments; the filtered subsets below can only
    // be summed per pair. Printing one against the other made the gate look worse than it is
    // (3380 vs 3824 → "40%", where the same accounting on both sides says ~49%) — the units
    // lesson in CLAUDE.md §12, met in the instrument built to apply it.
    const pairLines = (cs: readonly Clone[]): number => cs.reduce((n, c) => n + c.lines, 0)
    // What the shape pass found that is NOT new: the same file-pair regions the gate already
    // flags, re-found LARGER. That is the evidence for "consolidate against the cluster, not
    // the corner the gate shows you" — but it is not duplication the gate misses.
    const extends_ = shapeOnlyClones(shaped.clones, [], readShaped).length - only.length
    console.log(
      `jscpd: ${shaped.stats.clones} shape pairs → ${only.length} SHAPE-ONLY ` +
        `(${pairLines(only)} lines), ${extends_} extending a pair the gate already has, ` +
        `${shaped.stats.clones - only.length - extends_} filtered as self-overlaps / data tables.`,
    )
    console.log(
      `  the gate's own pass, summed the same way: ${clones.length} pairs / ` +
        `${pairLines(clones)} lines — so it sees ` +
        `${Math.round((pairLines(clones) / (pairLines(clones) + pairLines(only))) * 100)}% ` +
        `of the duplicated lines.\n` +
        '  SHAPE-ONLY clones differ only in identifiers — invisible to `bun run dup`, and NOT\n' +
        '  gated: a uniform data table is a legitimate false positive, which is why this is a lens.',
    )
    clones = only
    // Report the FILTERED set, never the shape pass's raw totals — those count the data
    // tables this lens exists to discard, and a percentage over them reads as a finding.
    stats = {
      files: shaped.stats.files,
      lines: shaped.stats.lines,
      clones: only.length,
      duplicatedLines: only.reduce((n, c) => n + c.lines, 0),
      percentage: Number.NaN,
    }
    reportPath = shaped.reportPath
    lens = ' (shape lens — identifiers erased; report only)'
  }

  console.log(summary(stats, lens))
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
      shape: argv.includes('--shape'),
    })
  } else {
    code = check(REPO_ROOT)
  }
  process.exit(code)
}

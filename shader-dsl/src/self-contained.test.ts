// ═══ #1681 C — THE MIRROR INVARIANT: shader-dsl/ names no path outside shader-dsl/ ═══
//
// WHAT THE MIRROR IS. This package is NOT published to npm. The consuming project takes it
// as a git SUBMODULE of a MIRROR repository produced by
//
//     git subtree split --prefix=shader-dsl
//
// The monorepo stays authoritative; the mirror is a read-only derivative and fixes flow back
// through X-GIS. Measured on this machine while the pivot was decided:
//
//   F1  the split yields 235 commits and the tree ROOTS AT THE PACKAGE — src/, examples/,
//       package.json, tsconfig.json, tsconfig.base.json, tsconfig.tests.json, README.md,
//       LICENSE, CHANGELOG.md, AUTHORING.md, AGENTS.md all sit at top level. No dist/ (it is
//       untracked), and — the load-bearing part — no `..`.
//   F2  the split is IDEMPOTENT: a second split over the same history reproduced head SHA
//       5afff6ec, so CI can FAST-FORWARD push the mirror. No force-push, no rewritten
//       submodule pins in the consumer.
//   F3  the mirror bare repo gc's to 1.6 MB against this monorepo's 498 MB .git; a consumer
//       clone is 1.7 MB carrying all 235 commits.
//   F4  a fresh consumer clone BUILDS STANDALONE: `tsc -p tsconfig.json`, with no
//       node_modules anywhere up the tree, exits 0 with 0 errors and emits 82 dist JS files.
//       Increment B's package-local tsconfig.base.json is what makes that resolve.
//
// WHY THE INVARIANT IS THE THING THAT MAKES IT WORK. F4 is not a property of the split — it
// is a property of the SOURCE. The split re-roots the tree at shader-dsl/, so any path that
// climbs out of the package (`../../shared/src/x`, `../tsconfig.base.json` at the monorepo
// root, `cd ..`) names a directory that DOES NOT EXIST in the consumer clone. Nothing
// downstream can repair that: the tarball is fine, the monorepo is fine, and the mirror —
// the only tree the consumer ever compiles — is broken, in a repository nobody here builds.
// So the invariant is F5: NOTHING TRACKED UNDER shader-dsl/ MAY REFERENCE A PATH OUTSIDE IT.
// Measured across the three surfaces a package can reach outward through, this file gates
// all three, plus the manifest hygiene the invariant leans on.
//
// WHAT EACH ARM CATCHES THAT NO OTHER ARM CAN
//   S1 relative imports      — the .ts source graph. 223 tracked .ts files, 771 relative
//                              specifiers, 0 escaping today. Only this arm reads source; a
//                              clean manifest cannot save a file that imports ../../shared.
//   S2 tsconfig chains       — `extends` + `paths`. These break BEFORE a single .ts file is
//                              read (TS5083, "cannot read file"), so S1 would still be green
//                              on a tree that cannot start compiling. NOTE: the extends half
//                              overlaps `src/tsconfig-drift.test.ts`'s B1 arm, which frames
//                              it around the older source-vendoring story and hand-LISTS the
//                              four configs; this arm derives the list from git, so a config
//                              that is added or moved cannot leave it vacuously green (#996).
//                              Collapsing the two is a follow-up, not a silent divergence:
//                              neither carries an allowlist, so they can only both-red.
//   S3 script `..` segments  — a script is not compiled, so S1/S2 never see it; it fails at
//                              the moment someone RUNS it in the mirror.
//   S4 pack lifecycle hooks  — not about the mirror at all: prepack fires inside `npm pack`
//                              AND `npm publish` and writes into the tracked working tree.
//   S5 publishConfig         — a SECOND authority for `exports` that no tool in use applies.
//   S6 files / sideEffects   — promises about paths, checked against git rather than the
//                              filesystem. Both are read by consumers, neither by tsc.
//   S7 publish-shaped set    — the monorepo-side obligation: a workspace with no
//                              `private: true` is one `npm publish` away from a broken
//                              upload, and the mirror pivot removed the reason to have any.
//
// ANTI-VACUITY (CLAUDE.md §12). Every scan here iterates a set that could be empty, and an
// empty set passes every `toEqual([])`. So each scan has a sanity arm, run first as its own
// named `it()`, proving the READER saw the thing: the import scan reports its file and
// specifier counts against measured floors; the tsconfig resolver is probed with a
// known-INSIDE and a known-OUTSIDE target; the manifest read is checked against witnesses
// that survive the fix; the workspaces array is checked non-empty.
//
// DERIVE FROM GIT, NEVER FROM THE FILESYSTEM. Every path question here is asked of
// `git ls-files`, never of `stat`. dist/ is gitignored (.gitignore:2), so a gate that
// stat'ed it would pass on a developer's built machine and fail in CI — and, worse, would be
// asking about a tree the mirror consumer never receives. Tracked is exactly the right set:
// a submodule checkout contains the tracked files and nothing else.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // shader-dsl/src
const PKG_DIR = resolve(HERE, '..') // shader-dsl — the root of the mirror
const REPO_ROOT = resolve(PKG_DIR, '..')

/** `git`, array-argv, output captured to a variable (CLAUDE.md §12 shell rules). Throws on a
 *  non-zero exit instead of returning `[]` — a silently empty list is precisely how a scan
 *  gate goes vacuous, and this helper feeds four of them. */
function git(cwd: string, ...args: string[]): string[] {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (run.error !== undefined) throw run.error
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} exited ${String(run.status)}: ${run.stderr}`)
  return run.stdout.split('\n').filter((line) => line.length > 0)
}

/** True iff `target` is at or under the package root — i.e. exists in the mirror at all. */
function insidePackage(target: string): boolean {
  const rel = relative(PKG_DIR, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Strip JSONC comments. String-aware by construction: a string literal is matched FIRST and
 *  returned verbatim, so a `//` inside one (a `$schema` URL) survives and an escaped quote
 *  cannot end the string early. */
const stripJsonc = (text: string): string =>
  text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
    m.startsWith('"') ? m : '',
  )

const readJsonc = <T>(abs: string): T => JSON.parse(stripJsonc(readFileSync(abs, 'utf8'))) as T

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  main?: string
  scripts?: Record<string, string>
  publishConfig?: Record<string, unknown>
  files?: string[]
  sideEffects?: boolean | string[]
}

/** Every tracked path under shader-dsl/, repo-relative and POSIX-separated. ONE git call
 *  feeds both the source scan (S1) and the tsconfig census (S2). */
const TRACKED = git(REPO_ROOT, 'ls-files', '--', 'shader-dsl')

const PKG = readJsonc<Manifest>(resolve(PKG_DIR, 'package.json'))
const SCRIPTS = PKG.scripts ?? {}
const FILES = PKG.files ?? []
const SIDE_EFFECTS: readonly string[] = Array.isArray(PKG.sideEffects) ? PKG.sideEffects : []

// ── S1: the source graph ────────────────────────────────────────────────────────────────

/** A relative module specifier in `from '…'`, a bare `import '…'`, or `import('…')`. */
const RELATIVE_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"'\n]+)["']/g

/** Coarse comment strip, the earth-literal-ratchet convention: this repo writes large banner
 *  comments that quote code, and a banner quoting an escaping import must not red the gate.
 *  Coarse is safe in one direction only — a `//` inside a string eats that line's tail, which
 *  can HIDE a violation but never invent one, and the sanity floor below is what catches a
 *  stripper that started eating the file. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

type RelImport = { readonly file: string; readonly spec: string; readonly target: string }

const TS_FILES = TRACKED.filter((f) => f.endsWith('.ts'))
const RELATIVE_IMPORTS: RelImport[] = TS_FILES.flatMap((file) => {
  const abs = resolve(REPO_ROOT, file)
  const source = stripComments(readFileSync(abs, 'utf8'))
  return [...source.matchAll(RELATIVE_SPEC)].map((m) => ({
    file,
    spec: m[1],
    target: resolve(dirname(abs), m[1]),
  }))
})

// ── S2: the tsconfig chains ─────────────────────────────────────────────────────────────

type Tsconfig = {
  extends?: string
  compilerOptions?: { paths?: Record<string, readonly string[]> } & Record<string, unknown>
}

/** Tracked tsconfigs at any depth in the package, by BASENAME — derived, not hand-listed, so
 *  a new or moved config joins the census automatically (#996: a path-keyed list needs a
 *  companion "every key still resolves"; having no list is strictly better). */
const CONFIGS = TRACKED.filter((f) =>
  /^tsconfig(\.[\w.-]+)?\.json$/.test(f.slice(f.lastIndexOf('/') + 1)),
)

type ConfigRef = { readonly file: string; readonly what: string; readonly spec: string }

/** Every outward reference a tsconfig can make: its `extends`, plus every `paths` target.
 *  `paths` is resolved against the CONFIG's own directory — none of these configs sets
 *  `baseUrl`, and TS 5.x resolves pathless `paths` relative to the containing file. */
function configRefs(file: string): ConfigRef[] {
  const cfg = readJsonc<Tsconfig>(resolve(REPO_ROOT, file))
  const refs: ConfigRef[] = []
  if (cfg.extends !== undefined) refs.push({ file, what: 'extends', spec: cfg.extends })
  for (const [alias, targets] of Object.entries(cfg.compilerOptions?.paths ?? {}))
    for (const target of targets) refs.push({ file, what: `paths['${alias}']`, spec: target })
  return refs
}

const CONFIG_REFS = CONFIGS.flatMap(configRefs)

// ── S3/S4: scripts ──────────────────────────────────────────────────────────────────────

/** A `..` PATH SEGMENT: `cd ..`, `bun ../scripts/x.ts`, `--dir ..`. Bounded on both sides so
 *  a `..` inside a word (`a..b`) is not a hit. */
const PARENT_SEGMENT = /(?:^|[\s"'`=:;&|(])\.\.(?=[/\\]|$|[\s"'`;&|)])/

/** The hooks npm fires around `pack` and `publish`. Forbidden in THIS manifest only. */
const PACK_LIFECYCLE = ['prepack', 'prepare', 'prepublish', 'prepublishOnly'] as const

// ── S5: publishConfig ───────────────────────────────────────────────────────────────────

/** The only `publishConfig` keys npm itself honours (F6). Everything else in there is a
 *  pnpm/yarn field override that the tools in use silently ignore. */
const NPM_HONOURED_PUBLISH_CONFIG = new Set(['access', 'tag', 'registry', 'provenance'])

// ── S6: files / sideEffects ─────────────────────────────────────────────────────────────

/** Paths a `files` or `sideEffects` entry may name even though git tracks nothing behind
 *  them, because a BUILD STEP guarantees the artifact exists by the time the entry is read.
 *  The value is the package script that produces it, and the arm below requires that script
 *  to be a real key of `scripts` — an allowlist whose promise nothing checks is prose.
 *
 *  EMPTY TODAY, deliberately. This package ships SOURCE: `exports` names ./src/*.ts (F10)
 *  and the mirror consumer compiles it, so nothing built needs naming. The record exists so
 *  that a future decision to ship compiled output is ONE ENTRY plus its script, rather than
 *  a rewrite of the gate — and so that the decision is visible in a diff. */
const BUILT_ARTIFACTS: Readonly<Record<string, string>> = {}

/** How many tracked paths a `files`-style pathspec expands to, asked from the package dir. */
const trackedBehind = (entry: string): number => git(PKG_DIR, 'ls-files', '--', entry).length

// ── S7: the publish-shaped workspace set ────────────────────────────────────────────────

const WORKSPACES =
  readJsonc<{ workspaces?: string[] }>(resolve(REPO_ROOT, 'package.json')).workspaces ?? []

/** Workspaces whose manifest does NOT say `private: true` — i.e. that `npm publish` would
 *  happily upload. Entries are plain directory names today; a glob entry would throw here
 *  rather than be silently skipped, which is the correct direction to fail. */
const PUBLISH_SHAPED = WORKSPACES.filter(
  (ws) => readJsonc<Manifest>(resolve(REPO_ROOT, ws, 'package.json')).private !== true,
)

/** Being publish-shaped is an OBLIGATION with a named owner, not a default. Shrink-only in
 *  BOTH directions (the earth-literal-ratchet contract): a publish-shaped workspace missing
 *  from here fails, and an entry whose workspace has since gained `private: true` also fails,
 *  so the exemption cannot outlive its reason. Values are machine-checked for an issue. */
const PUBLISHABLE: Readonly<Record<string, string>> = {
  'shader-dsl':
    'The mirror source (#1681 C). `git subtree split --prefix=shader-dsl` makes THIS manifest ' +
    'the root of the mirror repo the consumer submodules, so its name / version / exports / ' +
    'files stay meaningful outside the monorepo and `private: true` would be a claim about a ' +
    'tree that is consumed. This is NOT an npm publish — the pivot on #1681 dropped npm, the ' +
    'release script, the tag convention and the version-bump story. If the maintainer later ' +
    'decides the monorepo copy should carry `private: true`, delete this entry in the same commit.',
}

/** The derived, per-workspace failure a publish would produce — computed from the manifest
 *  and git rather than written down, so the report stays true for a workspace nobody has
 *  looked at yet. */
function publishFailure(ws: string): string {
  const dir = resolve(REPO_ROOT, ws)
  const manifest = readJsonc<Manifest>(resolve(dir, 'package.json'))
  const declared = manifest.files ?? []
  const empty = declared.filter(
    (e) => !e.startsWith('!') && git(dir, 'ls-files', '--', e).length === 0,
  )
  return (
    `${ws} (${manifest.name ?? '?'}): files=${JSON.stringify(declared)}` +
    (empty.length > 0 ? `, of which ${JSON.stringify(empty)} expand to ZERO tracked paths` : '') +
    `, main=${JSON.stringify(manifest.main)}`
  )
}

describe('#1681 C — the mirror invariant (F5) + the manifest hygiene it rests on', () => {
  // ── S1 ────────────────────────────────────────────────────────────────────────────────

  it('scan sanity — the import scanner SAW the package source', () => {
    // A scanner that matches nothing passes every downstream assertion. Floors are set below
    // today's measurement (223 tracked .ts files, 771 relative specifiers after comment
    // stripping — 773 in the raw text, two of them inside comments) so ordinary churn does
    // not trip them, and a broken `git ls-files`, regex or stripper does.
    expect(
      TS_FILES.length,
      '`git ls-files -- shader-dsl` reported fewer than 200 tracked .ts files (223 today). ' +
        'The file list is empty or truncated, so the S1 scan below is vacuous — fix the ' +
        'reader, not the assertion.',
    ).toBeGreaterThanOrEqual(200)
    expect(
      RELATIVE_IMPORTS.length,
      'The relative-import scan found fewer than 700 specifiers (771 today) across ' +
        `${String(TS_FILES.length)} files. RELATIVE_SPEC or stripComments stopped matching ` +
        'real imports; S1 would then be green on a package full of escaping imports.',
    ).toBeGreaterThanOrEqual(700)
  })

  it('S1 — every relative import in a tracked .ts file resolves INSIDE shader-dsl/', () => {
    const escaping = RELATIVE_IMPORTS.filter((i) => !insidePackage(i.target))
      .map((i) => `${i.file}: '${i.spec}' → ${relative(REPO_ROOT, i.target)}`)
      .sort()
    expect(
      escaping,
      'Relative import climbing OUT of shader-dsl/ (file: specifier → resolved path). The ' +
        'mirror is produced by `git subtree split --prefix=shader-dsl`, so its tree ROOTS at ' +
        'this package: each resolved path above is outside that root and simply does not ' +
        'exist in the consumer clone. The standalone `tsc -p tsconfig.json` that F4 measured ' +
        'at exit 0 / 82 emitted files then fails there with TS2307, in a repository nobody in ' +
        "this monorepo ever builds. Import through the package's own tree, or move the code " +
        'the import needs INTO shader-dsl/.',
    ).toEqual([])
  })

  // ── S2 ────────────────────────────────────────────────────────────────────────────────

  it('resolver sanity — `../tsconfig.base.json` from examples/ is INSIDE, `../../` is not', () => {
    // The real case this resolver must NOT mis-flag: examples/tsconfig.json climbs one level
    // and lands ON the package-local baseline. A resolver that rejected it would be red for a
    // legitimate config; one that accepted its `../../` sibling would be green for a broken
    // one. Both directions are probed, so neither ratchet arm below can ride a stuck resolver.
    const examplesDir = resolve(PKG_DIR, 'examples')
    expect(
      readJsonc<Tsconfig>(resolve(examplesDir, 'tsconfig.json')).extends,
      'examples/tsconfig.json no longer extends `../tsconfig.base.json` — the accept case ' +
        'this arm probes is hypothetical now; re-derive it from the real config.',
    ).toBe('../tsconfig.base.json')
    expect(resolve(examplesDir, '../tsconfig.base.json')).toBe(
      resolve(PKG_DIR, 'tsconfig.base.json'),
    )
    expect(insidePackage(resolve(examplesDir, '../tsconfig.base.json'))).toBe(true)
    expect(insidePackage(resolve(examplesDir, '../../tsconfig.base.json'))).toBe(false)

    // …and the JSONC reader really parsed these heavily-commented configs, rather than
    // returning `{}` and making the `paths` half of the census silently empty.
    expect(CONFIGS.length, `tracked tsconfigs found: ${CONFIGS.join(', ')}`).toBeGreaterThanOrEqual(
      4,
    )
    expect(CONFIGS).toContain('shader-dsl/examples/tsconfig.json')
    expect(
      Object.keys(readJsonc<Tsconfig>(resolve(PKG_DIR, 'tsconfig.base.json')).compilerOptions ?? {})
        .length,
      'read 0 compilerOptions from shader-dsl/tsconfig.base.json — the JSONC reader is broken',
    ).toBeGreaterThanOrEqual(10)
    expect(
      CONFIG_REFS.filter((r) => r.what === 'extends').length,
      'no `extends` was seen across the tracked tsconfigs — the census is empty and S2 is vacuous',
    ).toBeGreaterThanOrEqual(3)
  })

  it('S2 — every tsconfig `extends` and `paths` target terminates INSIDE shader-dsl/', () => {
    const escaping = CONFIG_REFS.filter(
      (r) =>
        !r.spec.startsWith('.') ||
        !insidePackage(resolve(dirname(resolve(REPO_ROOT, r.file)), r.spec)),
    )
      .map((r) =>
        r.spec.startsWith('.')
          ? `${r.file} ${r.what} '${r.spec}' → ${relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, r.file)), r.spec))}`
          : `${r.file} ${r.what} '${r.spec}' → a bare package specifier, resolved from node_modules`,
      )
      .sort()
    expect(
      escaping,
      'A tsconfig in this package reaches outside it (config, key, resolved target above). ' +
        'This breaks EARLIER than any source error: tsc reports TS5083 "cannot read file" at ' +
        'config-load time, before a single .ts file is parsed — which is exactly what a ' +
        'vendored or mirrored copy of this directory hits, because the subtree split roots ' +
        'the tree here and the monorepo above it is gone. A bare specifier fails the same way: ' +
        'F4 measured the consumer clone building with NO node_modules anywhere up the tree. ' +
        'Every chain must terminate at shader-dsl/tsconfig.base.json (#1681 B1).',
    ).toEqual([])
  })

  // ── S3 – S6: the package manifest ─────────────────────────────────────────────────────

  it('manifest sanity — shader-dsl/package.json was read and its witnesses recovered', () => {
    // Four gates below iterate this manifest. If the read returned `{}` — wrong path, parse
    // failure swallowed — all four pass on nothing. These witnesses are chosen to survive the
    // fix increment C lands, so this arm reds only when the READER is broken.
    expect(PKG.name, 'shader-dsl/package.json did not parse as this package').toBe(
      '@xgis/shader-dsl',
    )
    expect(typeof PKG.version).toBe('string')
    expect(
      Object.keys(SCRIPTS).length,
      'no `scripts` read — S3/S4 are vacuous',
    ).toBeGreaterThanOrEqual(1)
    expect(
      FILES.length,
      'no `files` entries read — the S6 files arm is vacuous',
    ).toBeGreaterThanOrEqual(4)
    expect(
      SIDE_EFFECTS.length,
      '`sideEffects` is not a non-empty array of paths. Either the reader is broken, or the ' +
        'field was set to `false`/removed — which is itself the bug this gate exists to ' +
        'notice: src/core/ir/builder.ts calls installStmtSink() at module scope, so this ' +
        'package DOES have module-level state and cannot claim to be side-effect-free.',
    ).toBeGreaterThanOrEqual(1)
  })

  it('S3 — no package script reaches outside the package', () => {
    const offenders = Object.entries(SCRIPTS)
      .filter(([, value]) => PARENT_SEGMENT.test(value))
      .map(([name, value]) => `${name} = ${value}`)
      .sort()
    expect(
      offenders,
      'Package script containing a `..` path segment (every offender is listed above, not ' +
        'just the first). It cannot run in the mirror, where there is no `..`: the subtree ' +
        'split re-roots the tree at this package, so the parent directory the script names is ' +
        "either the consumer's own project or nothing at all. Every script in this manifest " +
        'must be runnable from the package directory alone. Scoped to THIS manifest by ' +
        "design (F9) — the root package.json's `prepare: husky` is not this gate's business.",
    ).toEqual([])
  })

  it('S4 — the package manifest declares no pack/publish lifecycle script', () => {
    const present = PACK_LIFECYCLE.filter((hook) => Object.hasOwn(SCRIPTS, hook))
      .map((hook) => `${hook} = ${SCRIPTS[hook]}`)
      .sort()
    expect(
      present,
      'Pack/publish lifecycle hook in shader-dsl/package.json. `prepack` runs inside BOTH ' +
        '`npm pack` and `npm publish`, and this one WRITES CHANGELOG.md into the tracked ' +
        'working tree: a pack — an operation whose whole point is to be read-only — mutates ' +
        'the repository, and a Ctrl-C partway through leaves it mutated with nothing saying ' +
        'so. The changelog generator stays; it is invoked deliberately from the root ' +
        '`changelog` script, not as a side effect of packing. The mirror needs none of this ' +
        'either: it is a git submodule, never a tarball.',
    ).toEqual([])
  })

  it('S5 — publishConfig carries only keys npm honours', () => {
    const overrides = Object.keys(PKG.publishConfig ?? {})
      .filter((k) => !NPM_HONOURED_PUBLISH_CONFIG.has(k))
      .sort()
    expect(
      overrides,
      'publishConfig key that no tool in use applies. MEASURED (F6): neither npm 10.9.7 nor ' +
        'bun pm pack 1.3.11 applies publishConfig FIELD overrides — npm honours publishConfig ' +
        'natively only for access / tag / registry / provenance, and main/module/types/' +
        'exports/browser/typesVersions are a pnpm-and-yarn extension. So this block is a ' +
        'SECOND AUTHORITY for the entry points (CLAUDE.md §12) that changes nothing and has ' +
        'already drifted from the real one by a whole subpath: `./examples` is in `exports` ' +
        'and was never in publishConfig.exports — and cannot be, because tsconfig rootDir is ' +
        './src, so examples/ is never emitted to dist at all. The real `exports` map is the ' +
        'authority (F10: it resolves to SOURCE, ./src/*.ts, and stays that way); delete the ' +
        'overrides rather than teaching a second copy about a third subpath.',
    ).toEqual([])
  })

  it('S6 — every `files` entry expands to at least one TRACKED path', () => {
    const empty = FILES.filter((e) => !e.startsWith('!'))
      .filter((e) => !Object.hasOwn(BUILT_ARTIFACTS, e) && trackedBehind(e) === 0)
      .sort()
    expect(
      empty,
      '`files` entry that git tracks NOTHING behind. It is an empty promise: a fresh clone ' +
        'and the mirror submodule both contain exactly the tracked files, so the entry ships ' +
        'nothing there — `dist` is gitignored (.gitignore:2) and F1 confirms the split tree ' +
        'has no dist/. Asked of git, never of the filesystem, so this answer is the same on a ' +
        'built machine and in CI. If a build step will genuinely produce the path before it is ' +
        'read, add it to BUILT_ARTIFACTS here with the script that produces it.',
    ).toEqual([])
  })

  it('S6 — every `sideEffects` entry names a TRACKED file', () => {
    const missing = SIDE_EFFECTS.map((e) => e.replace(/^\.\//, ''))
      .filter(
        (e) => !Object.hasOwn(BUILT_ARTIFACTS, e) && !git(PKG_DIR, 'ls-files', '--', e).includes(e),
      )
      .sort()
    expect(
      missing,
      '`sideEffects` entry naming a path git does not track. This is not cosmetic: a bundler ' +
        'that trusts the list treats every module NOT on it as side-effect-free and tree-' +
        'shakes it away — and this package has exactly the state that makes that fatal. ' +
        'src/core/ir/builder.ts:355 calls installStmtSink() at module scope, writing into ' +
        "node.ts's `_stmtSink` (node.ts:100-102); drop that module and every builder call " +
        'throws SD0012 at runtime. Naming a path that does not exist in the consumer tree ' +
        'means the registration is not actually protected there, which is the ONLY reason ' +
        'this field exists. Entries must name paths the mirror really contains.',
    ).toEqual([])
  })

  it('S6 — BUILT_ARTIFACTS entries name a real build script and only shrink', () => {
    expect(
      Object.entries(BUILT_ARTIFACTS)
        .filter(([, script]) => !Object.hasOwn(SCRIPTS, script))
        .map(([path, script]) => `${path} → scripts['${script}'] does not exist`)
        .sort(),
      "BUILT_ARTIFACTS entry whose value is not a real key of this manifest's `scripts`. The " +
        'value must name the build step that guarantees the artifact exists — an exemption ' +
        'whose promise nothing checks is prose, not a gate.',
    ).toEqual([])
    expect(
      Object.keys(BUILT_ARTIFACTS)
        .filter((path) => trackedBehind(path) > 0)
        .sort(),
      'BUILT_ARTIFACTS entry that git now TRACKS — the exemption is stale. Delete it in the ' +
        'same commit that made the path tracked; this allowlist shrinks in both directions.',
    ).toEqual([])
  })

  // ── S7 ────────────────────────────────────────────────────────────────────────────────

  it('workspace sanity — the root workspaces array was read', () => {
    expect(
      WORKSPACES.length,
      'root package.json declared no `workspaces` — the S7 arms below compare two empty sets ' +
        'and pass on nothing',
    ).toBeGreaterThanOrEqual(10)
    expect(WORKSPACES).toContain('shader-dsl')
  })

  it('S7 — every publish-shaped workspace is an allowlisted obligation', () => {
    const unowned = PUBLISH_SHAPED.filter((ws) => !Object.hasOwn(PUBLISHABLE, ws))
      .map(publishFailure)
      .sort()
    expect(
      unowned,
      'Workspace with no `private: true`, and no entry in PUBLISHABLE saying who owns that. ' +
        'Publish-shaped is an OBLIGATION, not a default: one `npm publish` from that ' +
        'directory uploads whatever `files` expands to, and the report above shows entries ' +
        'that expand to ZERO tracked paths while `main`/`exports` name a source path the ' +
        'tarball does not contain — a package with no entry point. npm forbids republishing a ' +
        'version, so that upload is permanent and the version is burned. For @xgis/map this ' +
        'is #1685 (files ships only the gitignored dist; exports names ./src/index.ts). Fix ' +
        'it by adding `private: true` to that workspace — or, if it really is meant to leave ' +
        'the monorepo, add it here with the reason and its issue.',
    ).toEqual([])
  })

  it('S7 — an allowlisted workspace that went private must lose its entry', () => {
    const stale = Object.keys(PUBLISHABLE)
      .filter((ws) => !PUBLISH_SHAPED.includes(ws))
      .sort()
    expect(
      stale,
      'PUBLISHABLE entry whose workspace now carries `private: true` (or left the workspaces ' +
        'array). The obligation is discharged, so DELETE the entry in the same commit that ' +
        'discharged it — this pair of arms is a set equality, and a stale exemption is a ' +
        'failure rather than slack. Leaving it means the next reader believes a package is ' +
        'still meant to leave the monorepo when it is not.',
    ).toEqual([])
  })

  it('S7 — every PUBLISHABLE entry states a reason and cites an issue', () => {
    expect(
      Object.entries(PUBLISHABLE)
        .filter(([, reason]) => !/#\d+/.test(reason))
        .map(([ws]) => ws)
        .sort(),
      'PUBLISHABLE entry with no issue number — an exemption nobody can trace is an exemption ' +
        'nobody will remove.',
    ).toEqual([])
  })
})

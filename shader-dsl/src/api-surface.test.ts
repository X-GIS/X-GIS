// ═══ The public API surface is a COMMITTED artifact — a change to it is a diff (#1842) ═══
//
// WHAT THIS IS FOR. The changelog files one entry per squash-merged commit, and that entry's
// text is the commit SUBJECT — a human's summary, not the change's public-surface delta. The
// two come apart constantly: measured when this landed, 114 of the 210 first-parent commits
// touching `shader-dsl/` carry a subject that does not identify the package's change at all
// (100 unparseable → the changelog's `other` bucket, 14 scoped to another package). The
// witness is `b93df528`, whose subject begins `fix(ci)` and which added `linkVariants`,
// `GlLinker`, `VariantLinkResult`, `emitIdentity`, `EmitTarget` and `EmitIdentityInput` to
// `src/index.ts` — six public exports that no reader of the changelog can see.
//
// So the capture unit moves off the subject. A snapshot of the surface is a function of the
// TREE, so it exists at PR time and changes visibly in the diff: an export cannot join,
// leave, or change shape without the author updating this file and a reviewer seeing it.
//
// WHY THIS IS NOT #1653's REJECTED STALENESS GATE. That rejection (emit-changelog.ts:26-31)
// is about the CHANGELOG: an entry's text is the squash subject, which does not exist until
// the merge happens, so a PR-time check has nothing to check. It is exactly right, and it
// does not reach this file — nothing here reads a commit, a subject, or a history.
//
// WHAT IT DOES NOT DO. It is not semver and does not try to be: #1681 dropped the version
// story when increment C re-scoped to the subtree mirror, and a submodule pins a SHA. What a
// consumer gets instead is strictly more precise than a version number — `git diff` over two
// mirror SHAs of THIS FILE is the exact list of what changed for them.
//
// WHY ITS OWN READER, next to api-doc-coverage.test.ts's. The two measure different
// quantities — "is it documented" versus "what shape is it" — and that file's reader is
// deliberately shaped for its own question (keyed by definition site, because 195 definitions
// are reachable from two or more subpaths, which is the right key for a doc obligation and
// the WRONG one here: a symbol moving from `.` to `./dev` is a breaking change that
// definition-keying hides). They are not two authorities over one fact. What they do share is
// the compiler-API approach and the hardcoded compilerOptions.
//
// ON THE HARDCODED OPTIONS, MEASURED RATHER THAN INHERITED. api-doc-coverage.test.ts records
// `moduleResolution: 'classic'` as a silent kill switch that dropped `.` from 284 exports to
// 91 with zero diagnostics. Re-measured on THIS tree while building this file, that no longer
// reproduces: Bundler, Classic and Node10 all resolve identically — 355 / 33 / 17 / 222 —
// because #1825 gave every relative import an explicit `.js` specifier, which is exactly what
// classic resolution needed. The options stay hardcoded anyway: the property worth having is
// that the measured surface cannot move because a tsconfig moved, and that must not depend on
// the specifier migration staying complete. So do not reach for `moduleResolution` when this
// gate misbehaves — S1's message names what to check instead, and the cut that proves S1
// works is a broken ENTRY PATH, not a resolution mode.
//
// RE-BAKE (an intentional surface change): update the snapshot alongside the code change —
//   bun run bake:api-surface
// — and commit the diff. That diff IS the record; a reviewer reads it instead of trusting a
// subject line.

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, string>
}

const SNAPSHOT = join(PKG, 'src', '__api__', 'surface.md')
const UPDATE = process.env.UPDATE_API_SURFACE === '1'
const REBAKE = 'bun run bake:api-surface'

/** The subpaths that ARE the public API. Mirrors api-doc-coverage.test.ts's list, and arm S4
 *  there already pins it against `package.json` — so a new subpath cannot appear unnoticed in
 *  one file and not the other. */
const API_SUBPATHS = ['.', './dev', './emit-prod', './core/ir'] as const

/** Floors for the "did the reader read anything" arm. DELIBERATELY well under the real counts,
 *  which this reader measured at 355 / 33 / 17 / 222 when it landed. (Do not read those as
 *  api-doc-coverage.test.ts's 284 / 33 / 17 / 193 gone stale: that file counts the same `.`
 *  and `./core/ir` surface at an older commit, and its own arms pin its numbers.) This arm
 *  answers "is the reader alive"; the snapshot diff answers "did the surface change". A floor
 *  set AT the true count would make every legitimate addition fail HERE — in the arm whose
 *  message says the reader is broken — instead of in the snapshot diff, which is the only arm
 *  that can name what actually moved. */
const FLOOR: Readonly<Record<string, number>> = {
  '.': 200,
  './dev': 20,
  './emit-prod': 10,
  './core/ir': 120,
}

// ── the reader ──────────────────────────────────────────────────────────────────────────
const entryFile = (sub: string): string => join(PKG, manifest.exports[sub].replace(/^\.\//, ''))
const program = ts.createProgram(API_SUBPATHS.map(entryFile), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  types: [],
})
const checker = program.getTypeChecker()
const FORMAT = ts.TypeFormatFlags.NoTruncation
/** For a DECLARED type. `InTypeAlias` tells the printer it is printing the alias's own
 *  right-hand side, so it spells the type out instead of echoing the alias name. Without it
 *  34 aliases rendered as themselves — `DeclarableCapability  type  DeclarableCapability` —
 *  which is a stable, diffable line carrying no information at all, on exactly the types
 *  (`Capability`, `DeclarableCapability`) whose admitted members are the contract. */
const FORMAT_DECLARED = FORMAT | ts.TypeFormatFlags.InTypeAlias

interface Export {
  /** The name as a consumer imports it. */
  readonly name: string
  /** Package-relative file the definition lives in — `<home>#<name>` is the shape key. */
  readonly home: string
  readonly kind: string
  /** One line describing the shape: a signature, a member list, or a spelled-out type. */
  readonly shape: string
}

/** Order matters: a class is also a value, and an enum is also a variable. */
function kindOf(sym: ts.Symbol): string {
  const f = sym.getFlags()
  if (f & ts.SymbolFlags.Class) return 'class'
  if (f & ts.SymbolFlags.Interface) return 'interface'
  if (f & ts.SymbolFlags.TypeAlias) return 'type'
  if (f & ts.SymbolFlags.Enum) return 'enum'
  if (f & ts.SymbolFlags.Function) return 'function'
  if (f & ts.SymbolFlags.Variable) return 'const'
  return 'value'
}

/** A symbol-keyed member is named `__@<symbol>@<id>` internally, and that id moves with the
 *  TypeScript version — `FuncDecl`'s `ASSEMBLED_AS` slot arrived as `__@ASSEMBLED_AS@740`.
 *  Rendered as `[ASSEMBLED_AS]` it is both the source spelling and version-stable. */
const memberName = (name: string): string => name.replace(/^__@(.+)@\d+$/, '[$1]')

function memberText(prop: ts.Symbol): string {
  const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0]
  const type =
    decl === undefined
      ? '<no-declaration>'
      : checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, decl), undefined, FORMAT)
  // The `?` is load-bearing: #1670 made `Reflection.requiredFeatures` REQUIRED, which broke
  // every hand-built literal. That change is invisible in a name-only snapshot.
  const optional = prop.getFlags() & ts.SymbolFlags.Optional ? '?' : ''
  return `${memberName(prop.getName())}${optional}: ${type}`
}

/** One line of shape. Members are SORTED — declaration order is not part of an object type's
 *  contract, so ordering churn would be diff noise that trains a reviewer to skim.
 *
 *  MEMBERS ARE EXPANDED ONLY FOR AN OBJECT TYPE, and that guard is not defensive coding — it
 *  is a measured bug. `getPropertiesOfType` on a union of string literals returns the APPARENT
 *  members of `String`, so `DeclarableCapability` — the #1681 A2 type whose entire purpose is
 *  which capabilities it admits — rendered as 3 KB of `anchor`/`at`/`charAt`, with its actual
 *  members nowhere in the line. Worse for a snapshot, that junk carried `__@iterator@173`,
 *  whose number is a compiler-internal symbol id: it moves with the TypeScript version and
 *  would have re-baked this file on an unrelated dependency bump.
 *
 *  Nothing is truncated. `NoTruncation` makes a big const-asserted table (CODES) a long line,
 *  and a long line is the right trade: TypeScript's default cut-off would put a blind spot in
 *  exactly the region this gate claims to watch, and a diagnostic code joining `CODES` is a
 *  real change to what a consumer branches on. */
function shapeOf(sym: ts.Symbol): string {
  const f = sym.getFlags()
  if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class)) {
    const declared = checker.getDeclaredTypeOfSymbol(sym)
    if (declared.flags & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(declared)
      if (props.length > 0) return `{ ${props.map(memberText).sort().join('; ')} }`
    }
    // A union, an intersection, a primitive alias, or an empty shape — spell the type itself.
    return checker.typeToString(declared, undefined, FORMAT_DECLARED)
  }
  const decl = sym.getDeclarations()?.[0]
  if (decl === undefined) return '<no-declaration>'
  return checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, decl), undefined, FORMAT)
}

function exportsOf(sub: string): readonly Export[] {
  const sf = program.getSourceFile(entryFile(sub))
  if (sf === undefined) return []
  const mod = checker.getSymbolAtLocation(sf)
  if (mod === undefined) return []
  return checker
    .getExportsOfModule(mod)
    .map((sym) => {
      let target = sym
      if (sym.flags & ts.SymbolFlags.Alias) {
        try {
          target = checker.getAliasedSymbol(sym)
        } catch {
          /* an unresolvable alias keeps its own symbol — it is still a real export */
        }
      }
      const decl = target.getDeclarations()?.[0]
      const home =
        decl === undefined ? '<no-declaration>' : relative(PKG, decl.getSourceFile().fileName)
      return { name: sym.getName(), home, kind: kindOf(target), shape: shapeOf(target) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const perSubpath = new Map<string, readonly Export[]>(API_SUBPATHS.map((s) => [s, exportsOf(s)]))

/** Shapes keyed by DEFINITION, so a symbol reachable from three subpaths is described once.
 *  The per-subpath name lists above are what answer "importable from where". */
const shapes = new Map<string, Export>()
for (const defs of perSubpath.values()) for (const d of defs) shapes.set(`${d.home}#${d.name}`, d)

function render(): string {
  const lines: string[] = [
    `# ${manifest.name} — public API surface`,
    '',
    'GENERATED FILE — do not hand-edit. Re-bake with `' + REBAKE + '` and commit the diff.',
    '',
    'Every symbol a consumer can import, per `package.json` `exports` subpath, followed by one',
    'line of shape per definition. `shader-dsl/src/api-surface.test.ts` fails when this file and',
    'the tree disagree, so a public-surface change cannot land without appearing in a diff —',
    'which is what the changelog, filing one entry per commit SUBJECT, cannot show (#1842).',
    '',
    'This is not a version. A mirror consumer pins a SHA (#1681), and `git diff` over two SHAs',
    'of this file is the exact list of what changed for them.',
    '',
  ]
  for (const sub of API_SUBPATHS) {
    const defs = perSubpath.get(sub) ?? []
    lines.push(`## \`${sub}\` — ${defs.length} exports`, '', '```')
    for (const d of defs) lines.push(d.name)
    lines.push('```', '')
  }
  lines.push(`## Shapes — ${shapes.size} definitions`, '', '```')
  for (const key of [...shapes.keys()].sort()) {
    const d = shapes.get(key)
    if (d !== undefined) lines.push(`${key}  ${d.kind}  ${d.shape}`)
  }
  lines.push('```', '')
  return lines.join('\n')
}

// ── the arms ────────────────────────────────────────────────────────────────────────────
// S1 runs FIRST and asserts the QUANTITY THE READER MOVES, not the snapshot comparison that
// is downstream of it. Without it a reader that resolves nothing produces an empty document,
// the re-bake writes that empty document, and the gate is green over a surface it can no
// longer see — passing identically whether the package exports 527 symbols or zero.
describe('the reader sees the surface at all', () => {
  it('resolves every API subpath to a plausible number of exports', () => {
    for (const sub of API_SUBPATHS) {
      const count = (perSubpath.get(sub) ?? []).length
      expect(
        count,
        `${sub}: ${count} exports resolved, floor is ${FLOOR[sub]} — the READER is broken, ` +
          'not the manifest, and re-baking would write a snapshot over a surface it can no ' +
          `longer see. Check that \`${manifest.exports[sub]}\` still exists and is still the ` +
          "subpath's entry in package.json `exports`; a path this reader cannot resolve is " +
          'the cut that was used to prove this arm fires.',
      ).toBeGreaterThanOrEqual(FLOOR[sub])
    }
  })

  it('describes every export it found — no blank kinds, no blank shapes', () => {
    // A reader that enumerated names but failed to type them would still clear S1 and would
    // still produce a stable, diffable, WORTHLESS snapshot.
    for (const [sub, defs] of perSubpath) {
      for (const d of defs) {
        expect(d.name, `${sub}: an export with an empty name`).not.toBe('')
        expect(d.kind, `${sub}#${d.name}: no kind`).not.toBe('')
        expect(d.shape, `${sub}#${d.name}: no shape`).not.toBe('')
      }
    }
  })

  it('leaks no compiler-internal symbol id into a shape', () => {
    // A snapshot gate is worth nothing if it re-bakes on its own. `__@iterator@173` — the
    // `173` is an internal symbol id that moves with the TypeScript version — reached the
    // rendered shape of every string-literal union before `shapeOf` gained its object-type
    // guard, and would have turned a dependency bump into a surface change.
    for (const d of shapes.values()) {
      expect(
        d.shape,
        `${d.home}#${d.name}: a compiler-internal id reached the snapshot, which makes it ` +
          're-bake on a TypeScript upgrade. See shapeOf.',
      ).not.toMatch(/__@/)
    }
  })
})

describe('the committed snapshot matches the tree', () => {
  it('has not drifted', () => {
    const rendered = render()
    if (UPDATE) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true })
      writeFileSync(SNAPSHOT, rendered)
      return
    }
    let committed: string
    try {
      committed = readFileSync(SNAPSHOT, 'utf8')
    } catch {
      expect.fail(`${relative(PKG, SNAPSHOT)} is missing — bake it with \`${REBAKE}\``)
    }
    // Normalised for the same reason emit-goldens.test.ts normalises: the snapshot is
    // committed text and git may check it out with CRLF, while this renderer only emits LF.
    expect(
      rendered.replace(/\r\n/g, '\n'),
      'the public API surface changed. If that was intended, re-bake with `' +
        REBAKE +
        '` and commit the diff — it is the record of what a consumer has to deal with.',
    ).toBe(committed.replace(/\r\n/g, '\n'))
  })
})

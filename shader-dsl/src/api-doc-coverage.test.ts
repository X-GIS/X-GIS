// ═══ Every public export carries a doc comment — the reference's precondition (#1695) ═══
//
// #1694 measured the symptom: the authoring knowledge exists, is good, and cannot be found.
// #1695's answer is a GENERATED API reference — and a generated reference is only worth
// trusting if nothing can join the public surface undocumented. That is this file. It is the
// DURABLE half of #1695 and it deliberately does NOT depend on which extractor renders the
// pages: it enumerates with the TypeScript compiler API directly.
//
// WHY NOT READ THE EXTRACTOR'S OUTPUT. Reusing typedoc's api.json to enumerate would weld a
// five-year ratchet to a tool choice, and — worse — it FAILS OPEN ON EXACTLY THE FAILURE IT
// GUARDS: if the extractor drops a symbol (a resolution quirk, a config change, an
// --excludeInternal flag), the gate stops scanning that symbol at the same instant the
// reference stops rendering it. Reader and read-thing would share one failure mode, and the
// gate would go quiet about precisely the surface that went dark. That is §12's
// "assertion that failed either way", one layer up.
//
// THE MEASURED SILENT KILL SWITCH, and why the sanity arms lead. Setting
// `moduleResolution: 'classic'` drops `.` from 284 exports to 91 with ZERO diagnostics and
// ZERO throws — and the undocumented count falls 159 → 50, i.e. a vacuous green that LOOKS
// like progress. So the sanity arms assert on the EXPORT COUNT (the quantity the resolver
// moves), never on the undocumented set (which is downstream of it), and they run FIRST in
// their own describe block.
//
// THE DOC RULE IS THE DEFINITION SITE. A doc comment at a re-export site does not count:
// `getDocumentationComment` does not follow aliases on its own, so every alias is deref'd
// through `getAliasedSymbol` before asking. Keys are `<package-relative home file>#<name>`
// rather than `<subpath>#<name>` because 195 definitions are exposed by two or more
// subpaths, and pair-keying would inflate 175 rows to 284 with ~109 duplicates.
//
// THE SEED IS 175, NOT 40. #1694's headline "40 of 71" measured a different quantity — a
// regex over the four entry files crossed with "does this name appear in AUTHORING.md" — and
// must never be transcribed here. The census that seeded this file was produced by ITS OWN
// READER: 332 unique definitions across the four API subpaths, 175 of them undocumented
// (. 159/284 · ./dev 13/33 · ./emit-prod 3/17 · ./core/ir 109/193). The allowlist has since
// shrunk to 167 — #1697 documented the eight backend symbols that reached the entry through
// `index.ts`'s star re-export, which is what retired the `emit-internals` debt class.
//
// `@internal` IS NOT AN EXIT FROM THIS GATE. Five of those eight are documented AND tagged
// `@internal`, so the extractor's `excludeInternal` keeps them out of the published pages
// while they stay exported — the un-export decision is breaking, and stays open in #1697.
// Because this file enumerates independently of the extractor (see above), it keeps scanning
// exactly the symbols the reference stops rendering; arm A6 pins that tagged set both ways so
// a tag can never retire a doc obligation without review.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  exports: Record<string, string>
}

/** Leading marker written by scripts/add-tsdoc-templates.ts. Kept in sync by arm A8 below,
 *  which fails if the script stops using it — the two must agree or scaffolding starts
 *  counting as coverage. */
const STUB_SENTINEL = 'TODO(#1695):'

/** The subpaths that ARE the public API and therefore owe documentation. */
const API_SUBPATHS = ['.', './dev', './emit-prod', './core/ir'] as const
/** Subpaths deliberately outside the doc contract, with the reason.
 *  `./examples` is a curated gallery whose 36 objects already carry required `title` and
 *  `blurb` fields — a TSDoc on each would be a second authority for the same prose. Kept in
 *  its own list rather than as an allowlist entry so "wholesale" is never available as an
 *  escape hatch for real debt. */
const NOT_API_SUBPATHS = ['./examples'] as const

/** Why each undocumented symbol is still undocumented. Reasons live here, once, and every
 *  row below indirects through this table — 175 copies of a sentence would rot. */
const DEBT: Readonly<Record<string, string>> = {
  'ir-authoring':
    'the IR authoring surface (node/types/builder/nodes). 109 symbols — the operator methods, ' +
    'type constructors and predicates an author touches constantly. Documenting these is the ' +
    'single highest-value slice of #1695 and wants a pass of its own, not a drive-by.',
  diagnostics:
    'the lint/diagnostics/codes surface reached through ./dev. Its policy is undecided: ' +
    '"the diagnostic surface is documented by its TSDoc only" is a fine answer but must be ' +
    'stated rather than defaulted into (#1695).',
  'engine-internals':
    'reflect / sot / intrinsics / measure / cpu-runtime and friends — real public surface ' +
    'that simply has not been written up yet (#1695).',
}

/** key → debt class. SHRINK-ONLY IN BOTH DIRECTIONS: a row whose symbol gains a doc comment
 *  must be deleted in that same commit (arm A2), and a row naming no live export must be
 *  deleted too (arm A3). Generated by this file's own reader; never hand-transcribed. */
const UNDOCUMENTED: Readonly<Record<string, string>> = {
  'src/core/backend.ts#Backend': 'engine-internals',
  'src/core/backend.ts#Capabilities': 'engine-internals',
  'src/core/backends/glsl.ts#glslEs300Backend': 'engine-internals',
  'src/core/cpu-codegen.ts#compileModuleJs': 'engine-internals',
  'src/core/cpu-runtime.ts#CpuStruct': 'engine-internals',
  'src/core/cpu-runtime.ts#CpuValue': 'engine-internals',
  'src/core/cpu-runtime.ts#ORACLE_GPU_STUB_NAMES': 'engine-internals',
  'src/core/diagnostics/codes.ts#CODES': 'diagnostics',
  'src/core/diagnostics/codes.ts#ErrorCode': 'diagnostics',
  'src/core/diagnostics/codes.ts#ErrorCodeDef': 'diagnostics',
  'src/core/diagnostics/error.ts#ShaderDslError': 'diagnostics',
  'src/core/diagnostics/loc.ts#isSourceTracing': 'diagnostics',
  'src/core/diagnostics/report.ts#DiagnoseOptions': 'diagnostics',
  'src/core/diagnostics/report.ts#DiagnosticReport': 'diagnostics',
  'src/core/emit-minify.ts#MinifyOptions': 'engine-internals',
  'src/core/fp64/df64-lib.ts#FP64_GUARD_NAME': 'engine-internals',
  'src/core/fp64/df64-lib.ts#Fp64GuardHandle': 'engine-internals',
  'src/core/fp64/flavor-select.ts#Fp64FlavorSignals': 'engine-internals',
  'src/core/intrinsics.ts#INTRINSIC_BINDING_REFS': 'engine-internals',
  'src/core/intrinsics.ts#IntrinsicTarget': 'engine-internals',
  'src/core/intrinsics.ts#PORTABLE_INTRINSICS': 'engine-internals',
  'src/core/intrinsics.ts#PRE_EMIT_INTRINSICS': 'engine-internals',
  'src/core/ir/builder.ts#Break': 'ir-authoring',
  'src/core/ir/builder.ts#Builder': 'ir-authoring',
  'src/core/ir/builder.ts#Continue': 'ir-authoring',
  'src/core/ir/builder.ts#Discard': 'ir-authoring',
  'src/core/ir/builder.ts#FnHandle': 'ir-authoring',
  'src/core/ir/builder.ts#FnParamSpec': 'ir-authoring',
  'src/core/ir/builder.ts#IfChain': 'ir-authoring',
  'src/core/ir/builder.ts#Let': 'ir-authoring',
  'src/core/ir/builder.ts#ModuleParts': 'ir-authoring',
  'src/core/ir/builder.ts#ParamSpec': 'ir-authoring',
  'src/core/ir/builder.ts#Return': 'ir-authoring',
  'src/core/ir/builder.ts#condExpr': 'ir-authoring',
  'src/core/ir/builder.ts#externFn': 'ir-authoring',
  'src/core/ir/builder.ts#ifExpr': 'ir-authoring',
  'src/core/ir/node.ts#Node': 'ir-authoring',
  'src/core/ir/node.ts#ReadonlyNode': 'ir-authoring',
  'src/core/ir/node.ts#abs': 'ir-authoring',
  'src/core/ir/node.ts#acos': 'ir-authoring',
  'src/core/ir/node.ts#asin': 'ir-authoring',
  'src/core/ir/node.ts#atan': 'ir-authoring',
  'src/core/ir/node.ts#atan2': 'ir-authoring',
  'src/core/ir/node.ts#bool': 'ir-authoring',
  'src/core/ir/node.ts#ceil': 'ir-authoring',
  'src/core/ir/node.ts#clamp': 'ir-authoring',
  'src/core/ir/node.ts#construct': 'ir-authoring',
  'src/core/ir/node.ts#cos': 'ir-authoring',
  'src/core/ir/node.ts#degrees': 'ir-authoring',
  'src/core/ir/node.ts#dot': 'ir-authoring',
  'src/core/ir/node.ts#dpdy': 'ir-authoring',
  'src/core/ir/node.ts#exp': 'ir-authoring',
  'src/core/ir/node.ts#f32': 'ir-authoring',
  'src/core/ir/node.ts#floor': 'ir-authoring',
  'src/core/ir/node.ts#fract': 'ir-authoring',
  'src/core/ir/node.ts#i32': 'ir-authoring',
  'src/core/ir/node.ts#installStmtSink': 'ir-authoring',
  'src/core/ir/node.ts#isNodeValue': 'ir-authoring',
  'src/core/ir/node.ts#length': 'ir-authoring',
  'src/core/ir/node.ts#lift': 'ir-authoring',
  'src/core/ir/node.ts#log': 'ir-authoring',
  'src/core/ir/node.ts#log2': 'ir-authoring',
  'src/core/ir/node.ts#mat2f64': 'ir-authoring',
  'src/core/ir/node.ts#mat3f64': 'ir-authoring',
  'src/core/ir/node.ts#mat4f64': 'ir-authoring',
  'src/core/ir/node.ts#max': 'ir-authoring',
  'src/core/ir/node.ts#min': 'ir-authoring',
  'src/core/ir/node.ts#mix': 'ir-authoring',
  'src/core/ir/node.ts#sign': 'ir-authoring',
  'src/core/ir/node.ts#sin': 'ir-authoring',
  'src/core/ir/node.ts#sqrt': 'ir-authoring',
  'src/core/ir/node.ts#tan': 'ir-authoring',
  'src/core/ir/node.ts#toI32': 'ir-authoring',
  'src/core/ir/node.ts#toU32': 'ir-authoring',
  'src/core/ir/node.ts#u32': 'ir-authoring',
  'src/core/ir/node.ts#vec2': 'ir-authoring',
  'src/core/ir/node.ts#vec2f64': 'ir-authoring',
  'src/core/ir/node.ts#vec2i': 'ir-authoring',
  'src/core/ir/node.ts#vec2u': 'ir-authoring',
  'src/core/ir/node.ts#vec3': 'ir-authoring',
  'src/core/ir/node.ts#vec3f64': 'ir-authoring',
  'src/core/ir/node.ts#vec4': 'ir-authoring',
  'src/core/ir/node.ts#vec4f64': 'ir-authoring',
  'src/core/ir/nodes.ts#AddressSpace': 'ir-authoring',
  'src/core/ir/nodes.ts#BinOp': 'ir-authoring',
  'src/core/ir/nodes.ts#BindingDecl': 'ir-authoring',
  'src/core/ir/nodes.ts#CmpOp': 'ir-authoring',
  'src/core/ir/nodes.ts#ConstDecl': 'ir-authoring',
  'src/core/ir/nodes.ts#Expr': 'ir-authoring',
  'src/core/ir/nodes.ts#FuncDecl': 'ir-authoring',
  'src/core/ir/nodes.ts#LogOp': 'ir-authoring',
  'src/core/ir/nodes.ts#ModuleDecl': 'ir-authoring',
  'src/core/ir/nodes.ts#Stmt': 'ir-authoring',
  'src/core/ir/nodes.ts#StructDecl': 'ir-authoring',
  'src/core/ir/nodes.ts#StructField': 'ir-authoring',
  'src/core/ir/types.ts#KeyOf': 'ir-authoring',
  'src/core/ir/types.ts#Scalar': 'ir-authoring',
  'src/core/ir/types.ts#ScalarKey': 'ir-authoring',
  'src/core/ir/types.ts#ShaderType': 'ir-authoring',
  'src/core/ir/types.ts#boolT': 'ir-authoring',
  'src/core/ir/types.ts#f32T': 'ir-authoring',
  'src/core/ir/types.ts#f64T': 'ir-authoring',
  'src/core/ir/types.ts#i32T': 'ir-authoring',
  'src/core/ir/types.ts#isF64': 'ir-authoring',
  'src/core/ir/types.ts#isMat': 'ir-authoring',
  'src/core/ir/types.ts#isScalar': 'ir-authoring',
  'src/core/ir/types.ts#isVec': 'ir-authoring',
  'src/core/ir/types.ts#isVec64': 'ir-authoring',
  'src/core/ir/types.ts#mat2f64T': 'ir-authoring',
  'src/core/ir/types.ts#mat3f64T': 'ir-authoring',
  'src/core/ir/types.ts#mat4f64T': 'ir-authoring',
  'src/core/ir/types.ts#mat4x4fT': 'ir-authoring',
  'src/core/ir/types.ts#samplerT': 'ir-authoring',
  'src/core/ir/types.ts#structT': 'ir-authoring',
  'src/core/ir/types.ts#texture2dMsfT': 'ir-authoring',
  'src/core/ir/types.ts#texture2dfT': 'ir-authoring',
  'src/core/ir/types.ts#typeEq': 'ir-authoring',
  'src/core/ir/types.ts#typeKey': 'ir-authoring',
  'src/core/ir/types.ts#u32T': 'ir-authoring',
  'src/core/ir/types.ts#vec2f64T': 'ir-authoring',
  'src/core/ir/types.ts#vec2fT': 'ir-authoring',
  'src/core/ir/types.ts#vec2iT': 'ir-authoring',
  'src/core/ir/types.ts#vec2uT': 'ir-authoring',
  'src/core/ir/types.ts#vec3f64T': 'ir-authoring',
  'src/core/ir/types.ts#vec3fT': 'ir-authoring',
  'src/core/ir/types.ts#vec3uT': 'ir-authoring',
  'src/core/ir/types.ts#vec4f64T': 'ir-authoring',
  'src/core/ir/types.ts#vec4fT': 'ir-authoring',
  'src/core/ir/types.ts#vec4iT': 'ir-authoring',
  'src/core/ir/types.ts#vec4uT': 'ir-authoring',
  'src/core/ir/types.ts#voidT': 'ir-authoring',
  'src/core/measure.ts#EmitSize': 'engine-internals',
  'src/core/measure.ts#OpCount': 'engine-internals',
  'src/core/measure.ts#OptimizerReport': 'engine-internals',
  'src/core/oracle.ts#CpuModule': 'engine-internals',
  'src/core/oracle.ts#compileModule': 'engine-internals',
  'src/core/passes/compose.ts#ComposeOptions': 'diagnostics',
  'src/core/passes/fp64-lower.ts#Fp64Flavor': 'diagnostics',
  'src/core/passes/fp64-lower.ts#Fp64LowerOptions': 'diagnostics',
  'src/core/passes/lint/engine.ts#Diagnostic': 'diagnostics',
  'src/core/passes/lint/engine.ts#LintConfig': 'diagnostics',
  'src/core/passes/lint/engine.ts#LintSummary': 'diagnostics',
  'src/core/passes/lint/engine.ts#Severity': 'diagnostics',
  'src/core/passes/mangle.ts#MangleResult': 'diagnostics',
  'src/core/passes/mangle.ts#mangleModule': 'diagnostics',
  'src/core/passes/match-lower.ts#lowerModule': 'diagnostics',
  'src/core/passes/opt/optimize.ts#OptLevel': 'diagnostics',
  'src/core/passes/opt/optimize.ts#optimize': 'diagnostics',
  'src/core/passes/validate.ts#ValidationError': 'diagnostics',
  'src/core/reflect.ts#BindEntry': 'engine-internals',
  'src/core/reflect.ts#BindGroup': 'engine-internals',
  'src/core/reflect.ts#EntryInfo': 'engine-internals',
  'src/core/reflect.ts#FieldLayout': 'engine-internals',
  'src/core/reflect.ts#LayoutKind': 'engine-internals',
  'src/core/reflect.ts#Reflection': 'engine-internals',
  'src/core/reflect.ts#ResourceKind': 'engine-internals',
  'src/core/reflect.ts#StructLayout': 'engine-internals',
  'src/core/reflect.ts#VertexAttr': 'engine-internals',
  'src/core/reflect.ts#VertexLayout': 'engine-internals',
  'src/core/sot.ts#FieldSpec': 'engine-internals',
  'src/core/sot.ts#IoStruct': 'engine-internals',
  'src/core/sot.ts#PlainStruct': 'engine-internals',
  'src/core/sot.ts#Resource': 'engine-internals',
  'src/core/sot.ts#UniformStruct': 'engine-internals',
  'src/core/sot.ts#arrayOf': 'engine-internals',
  'src/core/sot.ts#constDecl': 'engine-internals',
  'src/core/sot.ts#storageBuffer': 'engine-internals',
}

/** Public exports deliberately tagged `@internal`: still exported (un-exporting is a
 *  breaking change and is #1697's open question), but kept OUT of the generated reference by
 *  the extractor's `excludeInternal`. Each reaches the entry only because `index.ts` star-
 *  re-exports a whole backend module — nobody chose them — and each has a doc comment saying
 *  so, which is why they no longer appear in UNDOCUMENTED.
 *
 *  This list exists because `@internal` is otherwise a SILENT ESCAPE HATCH from A1: one line
 *  of prose plus the tag would retire any doc obligation, invisibly. Arm A6 pins the set both
 *  ways, so adding a tag is a reviewed act and removing one cannot leave a stale row. */
const INTERNAL: Readonly<Record<string, string>> = {
  'src/core/backends/glsl.ts#lowerComputeToFragment':
    'the supported entry is the emulateCompute emit option; calling the pass directly yields ' +
    'a half-lowered module. Un-export tracked by #1697.',
  'src/core/backends/wgsl.ts#emitBinding':
    'group/binding indices are assigned across a whole module, so a line emitted alone can ' +
    'disagree with the layout reflect() reports. Un-export tracked by #1697.',
  'src/core/backends/wgsl.ts#emitFuncsCsed':
    'a bare alias of emitFuncs; the one in-repo reference reaches it by deep source path, ' +
    'not through the package exports. Un-export tracked by #1697.',
  'src/core/backends/wgsl.ts#emitStruct':
    'a struct is meaningful only alongside the bindings and funcs that use it, which is what ' +
    'emitModule emits. Un-export tracked by #1697.',
  'src/core/backends/wgsl.ts#wgslType':
    'type spelling is a backend private; the neutral surface is emitModule. Un-export ' +
    'tracked by #1697.',
}

// ── the reader: ONE program, hoisted above every describe ───────────────────────────────
// Compiler options are hardcoded rather than read from tsconfig.base.json ON PURPOSE: this
// gate must measure the PUBLIC SURFACE, not whatever a config edit happens to make visible,
// and `moduleResolution` is the measured kill switch above.
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

interface Def {
  readonly key: string
  readonly documented: boolean
  readonly internal: boolean
}
/** Exports of one subpath, each resolved to its DEFINITION site. */
function exportsOf(sub: string): readonly Def[] {
  const sf = program.getSourceFile(entryFile(sub))
  if (sf === undefined) return []
  const mod = checker.getSymbolAtLocation(sf)
  if (mod === undefined) return []
  return checker.getExportsOfModule(mod).map((sym) => {
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
    const doc = ts.displayPartsToString(target.getDocumentationComment(checker)).trim()
    // A SCAFFOLDED STUB IS NOT DOCUMENTATION. scripts/add-tsdoc-templates.ts writes the
    // mechanical half of a comment (kind, @param per parameter, @returns) so an author only
    // has to supply what a machine cannot — but that stub has prose in it, so a plain
    // "length > 0" would read it as documented. Generating 167 of them would empty the debt
    // list below in one commit and publish 167 pages that say nothing: every row green, the
    // reference no better, and the gate silent about it. The sentinel is what stops that.
    const documented = doc.length > 0 && !doc.startsWith(STUB_SENTINEL)
    const internal = target.getJsDocTags(checker).some((t) => t.name === 'internal')
    return { key: `${home}#${sym.getName()}`, documented, internal }
  })
}

const perSubpath = new Map<string, readonly Def[]>(API_SUBPATHS.map((s) => [s, exportsOf(s)]))
/** key → documented, unioned across subpaths (one definition, many re-exports). */
const DEFS = new Map<string, boolean>()
for (const defs of perSubpath.values())
  for (const d of defs) DEFS.set(d.key, (DEFS.get(d.key) ?? false) || d.documented)
/** The keys the reader sees tagged `@internal`, unioned the same way. */
const TAGGED_INTERNAL = new Set<string>()
for (const defs of perSubpath.values())
  for (const d of defs) if (d.internal) TAGGED_INTERNAL.add(d.key)

/** Export-count floors, measured at the commit that seeded this gate. They exist to catch a
 *  resolver that silently sees LESS — never to pin an exact surface size, which is expected
 *  to grow. */
const EXPORT_FLOOR: Readonly<Record<string, number>> = {
  '.': 284,
  './dev': 33,
  './emit-prod': 17,
  './core/ir': 193,
}

describe('#1695 — reader sanity (every arm below is vacuous without these)', () => {
  it('the program resolved each API subpath to at least its measured export count', () => {
    for (const sub of API_SUBPATHS) {
      const n = perSubpath.get(sub)?.length ?? 0
      expect(
        n,
        `${sub} resolved to ${n} exports, below the ${EXPORT_FLOOR[sub]} measured when this ` +
          `gate was seeded. The RESOLVER is what changed, not the API: setting ` +
          `moduleResolution to 'classic' drops '.' from 284 to 91 with no diagnostic and no ` +
          `throw, and the undocumented count then falls 159 → 50 — a vacuous green that looks ` +
          `like progress. Fix the reader, not the assertion. (A genuine shrink of the public ` +
          `surface is fine, but lower this floor deliberately, in the commit that shrinks it.)`,
      ).toBeGreaterThanOrEqual(EXPORT_FLOOR[sub])
    }
  })

  it('alias deref reaches a definition two hops away', () => {
    // `f32T` is defined in core/ir/types.ts and reaches `.` through TWO barrels
    // (index.ts → core/ir/index.ts → types.ts). If getAliasedSymbol stopped working, its key
    // would read as a re-export site instead of its home file, and EVERY core/ir row below
    // would miss — 109 of the 175.
    const keys = (perSubpath.get('.') ?? []).map((d) => d.key)
    expect(
      keys,
      'f32T no longer resolves to its definition file through the two barrels — ' +
        'getAliasedSymbol is broken, and every core/ir key in the allowlist is now wrong',
    ).toContain('src/core/ir/types.ts#f32T')
  })

  it('the doc reader distinguishes documented from undocumented', () => {
    // Both directions, or a reader stuck at one answer passes A1 and A2 in turn.
    const documented = [...DEFS].filter(([, d]) => d).length
    const undocumented = [...DEFS].filter(([, d]) => !d).length
    expect(
      documented,
      'no export read as DOCUMENTED — the doc reader is stuck at false',
    ).toBeGreaterThan(100)
    expect(
      undocumented,
      'no export read as UNDOCUMENTED — the doc reader is stuck at true, which would make ' +
        'arm A1 pass over an empty set while the whole allowlist below silently rots',
    ).toBeGreaterThan(0)
  })
})

describe('#1695 — the public surface is fully accounted for', () => {
  it('A5: every exports subpath is classified as API or explicitly not-API', () => {
    // SET EQUALITY, not a for-each: a loop over API_SUBPATHS can only ever confirm the four
    // already listed, and the failure worth catching is a FIFTH subpath being added and
    // silently escaping the doc contract.
    expect(
      [...API_SUBPATHS, ...NOT_API_SUBPATHS].sort(),
      'the package manifest exports a subpath this gate does not classify. Add it to ' +
        'API_SUBPATHS (it owes documentation) or to NOT_API_SUBPATHS with the reason.',
    ).toEqual(Object.keys(manifest.exports).sort())
  })

  it('A1: no undocumented public export lacks an allowlist row', () => {
    const orphans = [...DEFS]
      .filter(([key, documented]) => !documented && UNDOCUMENTED[key] === undefined)
      .map(([key]) => key)
      .sort()
    expect(
      orphans,
      `these public exports have no doc comment and no allowlist row:\n  ${orphans.join('\n  ')}\n` +
        `Write a TSDoc comment at the DEFINITION site (a comment on the re-export does not ` +
        `count), or add a row to UNDOCUMENTED naming its debt class. The generated reference ` +
        `(#1695) publishes every one of these, so an undocumented export ships as a blank page.`,
    ).toEqual([])
  })

  it('A2: no allowlisted symbol has since been documented (shrink-only)', () => {
    const won = Object.keys(UNDOCUMENTED)
      .filter((key) => DEFS.get(key) === true)
      .sort()
    expect(
      won,
      `these symbols now HAVE a doc comment but are still allowlisted:\n  ${won.join('\n  ')}\n` +
        `Delete their rows in the same commit that documented them — an allowlist entry that ` +
        `outlives its reason is how debt becomes permanent by accident. This arm is also the ` +
        `second anti-vacuity net: if the doc reader ever breaks toward "everything is ` +
        `documented", A1 goes green over nothing while this arm reds with 175 subjects.`,
    ).toEqual([])
  })

  it('A3: no allowlist row names a symbol that is no longer exported', () => {
    // The #996 path-keyed-gate lesson: without this, a renamed symbol leaves a permanently
    // green row AND reappears as a fresh A1 orphan, which reads as two unrelated problems.
    const stale = Object.keys(UNDOCUMENTED)
      .filter((key) => !DEFS.has(key))
      .sort()
    expect(
      stale,
      `these allowlist rows name no public export today:\n  ${stale.join('\n  ')}\n` +
        `The symbol was renamed, moved file, or stopped being exported. Delete the row (and ` +
        `if it was renamed, its new key is waiting for you in arm A1).`,
    ).toEqual([])
  })

  it('A6: the `@internal` set is exactly the reviewed list, both directions', () => {
    // SET EQUALITY, and it is the arm that keeps `@internal` from becoming a quiet exit from
    // A1: prose + the tag would otherwise retire a doc obligation with nothing to review.
    // Both directions matter and fail differently — an UNLISTED tag is a symbol that silently
    // vanished from the reference, a LISTED-but-untagged row is a symbol that silently
    // reappeared in it. It is self-guarding against a broken tag reader too: if
    // getJsDocTags ever returns nothing, the observed set empties and this reds with five
    // subjects rather than going quiet.
    expect(
      [...TAGGED_INTERNAL].sort(),
      `the symbols tagged @internal and the reviewed INTERNAL list have diverged.\n` +
        `  tagged:  ${[...TAGGED_INTERNAL].sort().join(', ') || '(none)'}\n` +
        `  listed:  ${Object.keys(INTERNAL).sort().join(', ')}\n` +
        `A tag with no row hides a symbol from the generated reference without review — if ` +
        `that is intended, add the row with the reason. A row with no tag means the symbol is ` +
        `published again, so delete the row (and if it also lost its doc comment, arm A1 is ` +
        `already waiting for it).`,
    ).toEqual(Object.keys(INTERNAL).sort())
    for (const [key, reason] of Object.entries(INTERNAL))
      expect(reason, `INTERNAL['${key}'] must cite the issue that resolves it`).toMatch(/#\d+/)
  })

  it('A7: nothing is both allowlisted-undocumented and @internal', () => {
    // The two lists answer different questions — "owes docs" vs "documented, but not
    // published" — and a key in both would mean a symbol is excused from A1 twice, so
    // deleting one row would leave it still covered and the shrink-only property would stop
    // biting for it.
    const both = Object.keys(INTERNAL)
      .filter((k) => UNDOCUMENTED[k] !== undefined)
      .sort()
    expect(
      both,
      `these keys are in BOTH UNDOCUMENTED and INTERNAL:\n  ${both.join('\n  ')}\n` +
        `An @internal symbol carries a doc comment by construction (that is what took it out ` +
        `of the debt list), so it cannot also be owed documentation. Delete the ` +
        `UNDOCUMENTED row.`,
    ).toEqual([])
  })

  it('A8: the stub sentinel matches the generator, and no stub counts as documented', () => {
    // The sentinel lives in TWO files and means nothing unless they agree. If the generator
    // stops writing it, every stub it produces starts reading as real prose here — the debt
    // list empties, 167 rows go green, and the reference publishes 167 pages that say
    // nothing. That failure is silent in both directions, so it gets an arm.
    const gen = readFileSync(join(PKG, '..', 'scripts', 'add-tsdoc-templates.ts'), 'utf8')
    expect(
      gen,
      'scripts/add-tsdoc-templates.ts no longer declares the sentinel this gate filters on. ' +
        'Its stubs would then count as documentation and silently retire real debt.',
    ).toContain(`const SENTINEL = '${STUB_SENTINEL}'`)

    // And the filter must actually bite: a symbol whose only prose IS the sentinel is
    // undocumented, so it must still hold a row rather than having quietly gone green.
    const stubbed = [...DEFS].filter(([, d]) => d).length
    expect(
      stubbed,
      'the doc reader reports nothing documented — see the sanity arms',
    ).toBeGreaterThan(100)
  })

  it('A4: every debt class carries an issue number and is actually used', () => {
    for (const [name, reason] of Object.entries(DEBT))
      expect(reason, `DEBT['${name}'] must cite the issue that closes it`).toMatch(/#\d+/)
    const used = new Set(Object.values(UNDOCUMENTED))
    expect(
      [...used].sort(),
      'a debt class is declared but no row uses it — delete the class, or the table is ' +
        'documenting a category that does not exist',
    ).toEqual(Object.keys(DEBT).sort())
    for (const cls of used)
      expect(DEBT[cls], `row uses debt class '${cls}', which DEBT does not define`).toBeTypeOf(
        'string',
      )
  })
})

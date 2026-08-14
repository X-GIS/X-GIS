// ═══ Scaffold TSDoc stubs for every undocumented public export (#1695) ═══
//
// The generated reference is only as good as the TSDoc behind it, and 167 public exports
// have none — so their pages render as a signature and nothing else. This writes the
// mechanical half of each comment (the kind, the type parameters, one `@param` per
// parameter, `@returns`, `@throws` where the body throws) so an author is left with the
// only part a machine cannot supply: what the thing is FOR.
//
// THE TRAP THIS SCRIPT IS BUILT AROUND. `getDocumentationComment` returns a comment's
// description text, so a stub with any prose in it reads as DOCUMENTED. Generating 167 of
// those would empty api-doc-coverage.test.ts's debt list in one commit, turn every one of
// its rows green, and publish 167 pages that say nothing — strictly worse than today, where
// the surface is undocumented but the gate says so out loud.
//
// So every stub leads with the SENTINEL below, and the gate treats a description starting
// with it as undocumented. A stub is scaffolding, not coverage; it buys nothing until a
// human replaces the sentinel line, and until then the row stays in the debt list where it
// belongs.
//
//   bun scripts/add-tsdoc-templates.ts            # dry run — prints what it would write
//   bun scripts/add-tsdoc-templates.ts --write    # applies
//   bun scripts/add-tsdoc-templates.ts --write --filter core/ir/node.ts
//
// Idempotent: a declaration that already carries ANY JSDoc is never touched, so re-running
// after hand-writing some docs only scaffolds what is still bare.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = join(ROOT, 'shader-dsl')

/** The marker that keeps a stub out of the coverage count. Must match the constant of the
 *  same name in shader-dsl/src/api-doc-coverage.test.ts — that file's arm asserts it. */
const SENTINEL = 'TODO(#1695):'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const LIST = args.includes('--list')
const FILTER = args[args.indexOf('--filter') + 1]?.startsWith('--')
  ? undefined
  : args[args.indexOf('--filter') + 1]

const ENTRIES = ['index.ts', 'dev.ts', 'emit-prod.ts', join('core', 'ir', 'index.ts')].map((f) =>
  join(PKG, 'src', f),
)
const program = ts.createProgram(ENTRIES, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  types: [],
})
const checker = program.getTypeChecker()

interface Stub {
  readonly file: string
  readonly pos: number
  readonly indent: string
  readonly name: string
  readonly key: string
  readonly decl: ts.Declaration
  readonly sym: ts.Symbol
}

/** Does this declaration already carry a JSDoc block? Uses the compiler's own view rather
 *  than a regex, so a comment separated by blank lines or attributes still counts. */
const hasJsDoc = (decl: ts.Declaration): boolean =>
  (ts.getJSDocCommentsAndTags(decl) ?? []).length > 0

/** The node whose leading trivia a comment must attach to — for `export const x = …` that is
 *  the STATEMENT, not the variable declaration, or the comment lands inside the `const`. */
function anchorOf(decl: ts.Declaration): ts.Node {
  let n: ts.Node = decl
  while (
    n.parent !== undefined &&
    (ts.isVariableDeclarationList(n.parent) || ts.isVariableStatement(n.parent))
  )
    n = n.parent
  return n
}

function paramsOf(decl: ts.Declaration): readonly ts.ParameterDeclaration[] {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl.parameters
  if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
    const init = decl.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.parameters
  }
  return []
}

function typeParamsOf(decl: ts.Declaration): readonly ts.TypeParameterDeclaration[] {
  const d = decl as unknown as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }
  return d.typeParameters ?? []
}

/** A one-word noun for the declaration, used to make the sentinel line less generic. */
function kindOf(decl: ts.Declaration): string {
  if (ts.isInterfaceDeclaration(decl)) return 'interface'
  if (ts.isTypeAliasDeclaration(decl)) return 'type'
  if (ts.isClassDeclaration(decl)) return 'class'
  if (ts.isEnumDeclaration(decl)) return 'enum'
  if (paramsOf(decl).length > 0 || ts.isFunctionDeclaration(decl)) return 'function'
  return 'value'
}

/** The error classes the body actually constructs, so `@throws` names the real type instead
 *  of being an empty prompt. Syntactic on purpose: a checker-based effect analysis is not
 *  worth it here, and a name that is wrong costs an author one deletion. */
function thrownTypes(decl: ts.Declaration): string[] {
  const out = new Set<string>()
  const walk = (n: ts.Node): void => {
    if (ts.isThrowStatement(n) && n.expression !== undefined) {
      const e = n.expression
      if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) out.add(e.expression.text)
      else out.add('')
    }
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(decl, walk)
  return [...out]
}

/** Render a type as prose-safe inline code, collapsing the whitespace `typeToString` emits
 *  for object literals so a `@param` line stays one line. */
function typeText(type: ts.Type): string {
  const t = checker
    .typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > 90 ? `${t.slice(0, 87)}…` : t
}

/** The call signature of a declaration, if it has one. */
function signatureOf(decl: ts.Declaration, sym: ts.Symbol): ts.Signature | undefined {
  const type = checker.getTypeOfSymbolAtLocation(sym, decl)
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0]
}

/** EVERYTHING here is derived from the declaration — no sentinel, because none of it needs a
 *  human. The sentinel is spent only on the two things a machine genuinely cannot write:
 *  the summary (what this is FOR) and, for callables, a worked example.
 *
 *  That split is the point of this script. A stub that is all TODO gives an author 165
 *  blank forms; a stub that has already filled the type-derived half leaves one sentence
 *  and one snippet per symbol, which is work an agent can actually finish. */
function template(
  decl: ts.Declaration,
  sym: ts.Symbol,
  subpaths: readonly string[],
  indent: string,
): string {
  const kind = kindOf(decl)
  const lines: string[] = []

  // The one thing that must be written by a person. Named by kind so the prompt is concrete.
  lines.push(`${SENTINEL} one line — what this ${kind} is for.`)

  const from = subpaths.map((sp) => `\`${sp}\``).join(', ')
  lines.push('')
  lines.push(`Exported from ${from}.`)

  const tps = typeParamsOf(decl)
  const ps = paramsOf(decl)
  const sig = signatureOf(decl, sym)

  if (tps.length > 0 || ps.length > 0 || sig !== undefined) lines.push('')

  for (const tp of tps) {
    const c = tp.constraint !== undefined ? ` Constrained to \`${tp.constraint.getText()}\`.` : ''
    const d = tp.default !== undefined ? ` Defaults to \`${tp.default.getText()}\`.` : ''
    lines.push(`@typeParam ${tp.name.getText()} —${c}${d}`.trimEnd())
  }

  for (const p of ps) {
    const pname = ts.isIdentifier(p.name) ? p.name.text : p.name.getText()
    const t = typeText(checker.getTypeAtLocation(p))
    const optional = p.questionToken !== undefined || p.initializer !== undefined
    const def = p.initializer !== undefined ? ` Defaults to \`${p.initializer.getText()}\`.` : ''
    lines.push(`@param ${pname} — \`${t}\`${optional ? ', optional.' : '.'}${def}`)
  }

  if (sig !== undefined) {
    const ret = typeText(checker.getReturnTypeOfSignature(sig))
    if (ret !== 'void') lines.push(`@returns \`${ret}\`.`)
  }

  for (const t of thrownTypes(decl))
    lines.push(t === '' ? '@throws on invalid input.' : `@throws {${t}}`)

  // A worked example is the other thing only a person can supply, and the thing a reference
  // is most often opened for. Only asked of callables — an example of a type alias is prose.
  if (sig !== undefined) {
    lines.push('')
    lines.push(`@example`)
    lines.push('```ts')
    lines.push(`${SENTINEL} a minimal, runnable call.`)
    lines.push('```')
  }

  const body = lines.map((l) => (l === '' ? `${indent} *` : `${indent} *  ${l}`)).join('\n')
  return `${indent}/** ${lines[0]}\n${body.split('\n').slice(1).join('\n')}\n${indent} */\n`
}

// ── collect ───────────────────────────────────────────────────────────────────────────────
const seen = new Map<string, string[]>()
const stubs: Stub[] = []
/** entry file -> the import specifier a reader types. */
const SPECIFIER: Readonly<Record<string, string>> = {
  'index.ts': '@xgis/shader-dsl',
  'dev.ts': '@xgis/shader-dsl/dev',
  'emit-prod.ts': '@xgis/shader-dsl/emit-prod',
  'index.ts:core/ir': '@xgis/shader-dsl/core/ir',
}
const specifierOf = (entry: string): string =>
  entry.includes(join('core', 'ir'))
    ? SPECIFIER['index.ts:core/ir']
    : SPECIFIER[entry.split(/[\\/]/).pop()!]

// A symbol reachable from several subpaths is listed once, naming them all.
for (const entry of ENTRIES) {
  const sf = program.getSourceFile(entry)
  const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf)
  if (mod === undefined) continue
  for (const sym of checker.getExportsOfModule(mod)) {
    let target = sym
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        target = checker.getAliasedSymbol(sym)
      } catch {
        continue
      }
    }
    const decl = target.getDeclarations()?.[0]
    if (decl === undefined) continue
    const file = decl.getSourceFile().fileName
    if (!file.startsWith(join(PKG, 'src'))) continue
    const rel = relative(PKG, file).replace(/\\/g, '/')
    if (FILTER !== undefined && !rel.includes(FILTER)) continue

    const key = `${rel}#${target.getName()}`
    const spec = specifierOf(entry)
    if (seen.has(key)) {
      const subs = seen.get(key)!
      if (!subs.includes(spec)) subs.push(spec)
      continue
    }
    seen.set(key, [spec])

    const docText = ts.displayPartsToString(target.getDocumentationComment(checker)).trim()
    if (docText.length > 0) continue // already documented — never overwrite
    if (hasJsDoc(decl)) continue // has a JSDoc block (tags only, e.g. @deprecated)

    const anchor = anchorOf(decl)
    const pos = anchor.getStart(anchor.getSourceFile(), false)
    const lineStart = anchor
      .getSourceFile()
      .getLineStarts()
      .reduce((best, s) => (s <= pos && s > best ? s : best), 0)
    const indent =
      anchor
        .getSourceFile()
        .text.slice(lineStart, pos)
        .match(/^[ \t]*/)?.[0] ?? ''
    stubs.push({
      file,
      pos: lineStart,
      indent,
      name: target.getName(),
      key,
      decl,
      sym: target,
    })
  }
}

// ── list ──────────────────────────────────────────────────────────────────────────────────
// The work queue. Every line is one symbol still needing the two things a machine cannot
// write, so an agent can be handed a slice of this directly:
//   bun scripts/add-tsdoc-templates.ts --list --filter core/ir
if (LIST) {
  for (const st of [...stubs].sort((a, b) => a.key.localeCompare(b.key))) {
    const line = st.decl.getSourceFile().getLineAndCharacterOfPosition(st.pos).line + 1
    console.log(`${relative(ROOT, st.file)}:${line}\t${st.name}\t${kindOf(st.decl)}`)
  }
  console.log(
    `\n${stubs.length} symbol(s) still need a summary${stubs.length > 0 ? ' (and an example, where callable)' : ''}.`,
  )
  process.exit(0)
}

// ── apply ─────────────────────────────────────────────────────────────────────────────────
const byFile = new Map<string, Stub[]>()
for (const s of stubs) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s])

let written = 0
for (const [file, list] of byFile) {
  // Bottom-up, so every insertion leaves the earlier offsets valid.
  const ordered = [...list].sort((a, b) => b.pos - a.pos)
  let src = readFileSync(file, 'utf8')
  for (const s of ordered)
    src =
      src.slice(0, s.pos) +
      template(s.decl, s.sym, seen.get(s.key) ?? [], s.indent) +
      src.slice(s.pos)
  if (WRITE) writeFileSync(file, src)
  written += list.length
  console.log(
    `${WRITE ? 'wrote' : 'would write'} ${String(list.length).padStart(3)}  ${relative(ROOT, file)}`,
  )
}

console.log(
  `\n${WRITE ? 'Inserted' : 'Would insert'} ${written} TSDoc stub(s) across ${byFile.size} file(s).`,
)
if (written > 0)
  console.log(
    `Each leads with "${SENTINEL}" and is therefore counted as UNDOCUMENTED by\n` +
      `shader-dsl/src/api-doc-coverage.test.ts — a stub is scaffolding, not coverage. Replace\n` +
      `the sentinel line with real prose to retire a row from that gate's debt list.` +
      (WRITE
        ? '\nRun `bun run build` before committing: the stubs change no code, but do not assume.'
        : ''),
  )

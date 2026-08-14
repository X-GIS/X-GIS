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
  readonly text: string
  readonly name: string
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

/** Does the body throw? Cheap syntactic scan — a `@throws` slot in the stub is a prompt, and
 *  a wrong prompt costs an author one deletion, while a missing one costs a reader the fact. */
function throws(decl: ts.Declaration): boolean {
  let found = false
  const walk = (n: ts.Node): void => {
    if (found) return
    if (ts.isThrowStatement(n)) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(decl, walk)
  return found
}

function template(decl: ts.Declaration, name: string, indent: string): string {
  const kind = kindOf(decl)
  const lines: string[] = [`${SENTINEL} what is this ${kind} for, and when does an author`]
  lines.push(`reach for it rather than the obvious alternative?`)

  const tps = typeParamsOf(decl)
  const ps = paramsOf(decl)
  if (tps.length > 0 || ps.length > 0 || kind === 'function') lines.push('')
  for (const tp of tps) lines.push(`@typeParam ${tp.name.getText()} — `)
  for (const p of ps) {
    const pname = ts.isIdentifier(p.name) ? p.name.text : p.name.getText()
    const opt = p.questionToken !== undefined || p.initializer !== undefined ? ' (optional)' : ''
    lines.push(`@param ${pname} —${opt}`)
  }
  if (kind === 'function') lines.push('@returns ')
  if (throws(decl)) lines.push('@throws ')

  const body = lines.map((l) => (l === '' ? `${indent} *` : `${indent} *  ${l}`)).join('\n')
  return `${indent}/** ${lines[0]}\n${body.split('\n').slice(1).join('\n')}\n${indent} */\n`
}

// ── collect ───────────────────────────────────────────────────────────────────────────────
const seen = new Set<string>()
const stubs: Stub[] = []

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
    if (seen.has(key)) continue
    seen.add(key)

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
      text: template(decl, target.getName(), indent),
    })
  }
}

// ── apply ─────────────────────────────────────────────────────────────────────────────────
const byFile = new Map<string, Stub[]>()
for (const s of stubs) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s])

let written = 0
for (const [file, list] of byFile) {
  // Bottom-up, so every insertion leaves the earlier offsets valid.
  const ordered = [...list].sort((a, b) => b.pos - a.pos)
  let src = readFileSync(file, 'utf8')
  for (const s of ordered) src = src.slice(0, s.pos) + s.text + src.slice(s.pos)
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

// ═══ Module Resolver ═══
// Resolves import statements by parsing referenced files
// and extracting exported symbols (presets, functions, etc.)

import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'

/**
 * A file reader function — abstracted for testability.
 * In real usage, reads from filesystem. In tests, can be mocked.
 */
export type FileReader = (path: string) => string | null

/**
 * Resolve all imports in a program, merging imported symbols.
 * Returns a new program with imported statements prepended.
 */
export function resolveImports(
  program: AST.Program,
  basePath: string,
  readFile: FileReader,
): AST.Program {
  const resolved = new Set<string>()
  const imported: AST.Statement[] = []

  for (const stmt of program.body) {
    if (stmt.kind === 'ImportStatement') {
      const filePath = resolveFilePath(stmt.path, basePath)
      if (resolved.has(filePath)) continue
      resolved.add(filePath)

      const source = readFile(filePath)
      if (!source) {
        throw new Error(`[Module] Could not read file: ${filePath} (imported at line ${stmt.line})`)
      }

      const tokens = new Lexer(source).tokenize()
      const moduleAst = new Parser(tokens).parse()

      // Extract named exports matching the import list
      for (const modStmt of moduleAst.body) {
        const name = getStatementName(modStmt)
        if (name && stmt.names.includes(name)) {
          imported.push(modStmt)
        }
      }
    }
  }

  // Prepend imported statements, then original (excluding import statements)
  const body = [
    ...imported,
    ...program.body.filter(s => s.kind !== 'ImportStatement'),
  ]

  return { kind: 'Program', body }
}

function getStatementName(stmt: AST.Statement): string | null {
  switch (stmt.kind) {
    case 'PresetStatement': return stmt.name
    case 'FnStatement': return stmt.name
    case 'SourceStatement': return stmt.name
    case 'LetStatement': return stmt.name
    case 'SymbolStatement': return stmt.name
    case 'StyleStatement': return stmt.name
    default: return null
  }
}

/**
 * Async file reader — the browser uses fetch() which is always async.
 * Returning null signals "file not found" and raises a helpful error.
 */
export type AsyncFileReader = (path: string) => Promise<string | null>

/**
 * Async variant of resolveImports — uses an async file reader so the browser
 * can fetch() imported files over HTTP. Functionally equivalent to the sync
 * version, just awaiting each read.
 */
export async function resolveImportsAsync(
  program: AST.Program,
  basePath: string,
  readFile: AsyncFileReader,
): Promise<AST.Program> {
  const resolved = new Set<string>()
  const imported: AST.Statement[] = []

  for (const stmt of program.body) {
    if (stmt.kind === 'ImportStatement') {
      const filePath = resolveFilePath(stmt.path, basePath)
      if (resolved.has(filePath)) continue
      resolved.add(filePath)

      const source = await readFile(filePath)
      if (!source) {
        throw new Error(`[Module] Could not read file: ${filePath} (imported at line ${stmt.line})`)
      }

      const tokens = new Lexer(source).tokenize()
      const moduleAst = new Parser(tokens).parse()

      for (const modStmt of moduleAst.body) {
        const name = getStatementName(modStmt)
        if (name && stmt.names.includes(name)) {
          imported.push(modStmt)
        }
      }
    }
  }

  const body = [
    ...imported,
    ...program.body.filter(s => s.kind !== 'ImportStatement'),
  ]

  return { kind: 'Program', body }
}

function resolveFilePath(importPath: string, basePath: string): string {
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    // Relative path — resolve against base directory
    const base = basePath.endsWith('/')
      ? basePath
      : basePath.substring(0, basePath.lastIndexOf('/') + 1)
    // Normalize: remove leading "./" from import since base already provides context
    if (base === '' || base === './') return importPath
    return base + importPath.replace(/^\.\//, '')
  }
  return importPath
}

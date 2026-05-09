// ═══ Module Resolver ═══
// Resolves import statements by parsing referenced files
// and extracting exported symbols (presets, functions, etc.)

import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
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

      const xgisSource = looksLikeMapboxStyle(source)
        ? convertMapboxStyle(JSON.parse(source))
        : source

      const tokens = new Lexer(xgisSource).tokenize()
      const moduleAst = new Parser(tokens).parse()

      const splice = stmt.names.length === 0
      for (const modStmt of moduleAst.body) {
        if (splice) {
          if (modStmt.kind !== 'ImportStatement') imported.push(modStmt)
        } else {
          const name = getStatementName(modStmt)
          if (name && stmt.names.includes(name)) {
            imported.push(modStmt)
          }
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

      // Auto-detect Mapbox style.json: a JSON object with `version` and
      // `layers` is the spec shape. Detection happens BEFORE parsing
      // because raw style.json doesn't lex as xgis. Splice form
      // (`import "url"`, no names) feeds the converted output's full
      // body into the host program; cherry-pick form requires xgis
      // content because it picks named exports.
      const xgisSource = looksLikeMapboxStyle(source)
        ? convertMapboxStyle(JSON.parse(source))
        : source

      const tokens = new Lexer(xgisSource).tokenize()
      const moduleAst = new Parser(tokens).parse()

      const splice = stmt.names.length === 0
      for (const modStmt of moduleAst.body) {
        if (splice) {
          // Splice form: take every top-level statement EXCEPT nested
          // imports (we already walked the importing program; nested
          // imports would need a recursion guard the v1 doesn't ship).
          if (modStmt.kind !== 'ImportStatement') imported.push(modStmt)
        } else {
          const name = getStatementName(modStmt)
          if (name && stmt.names.includes(name)) {
            imported.push(modStmt)
          }
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

/** Heuristic: does this string look like a Mapbox v8 style.json?
 *  Trims leading whitespace, checks the opening brace, and parses
 *  enough to see `version` (an integer >= 7) + `layers` (array). The
 *  full JSON.parse only happens if the prefix passes — keeps the cost
 *  bounded for plausible-but-wrong inputs (e.g. an HTML 404 page). */
function looksLikeMapboxStyle(s: string): boolean {
  const trimmed = s.trimStart()
  if (!trimmed.startsWith('{')) return false
  try {
    const j = JSON.parse(trimmed)
    return j !== null && typeof j === 'object'
      && typeof j.version === 'number' && j.version >= 7
      && Array.isArray(j.layers)
  } catch { return false }
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

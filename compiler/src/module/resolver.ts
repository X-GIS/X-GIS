// ═══ Module Resolver ═══
// Resolves import statements by parsing referenced files and merging their
// exported symbols. Resolution is RECURSIVE (an imported file may itself import
// others — the theme/fragment ecosystem base ← palette ← overrides), with:
//   • a path-stack cycle detector (a cycle is an error naming the full chain);
//   • a resolved-once memo that also handles the diamond case (A imports B,C;
//     B,C import D → D resolved once, not an error);
//   • `import * as ns from "..."` namespacing (block-level defs spliced under a
//     `ns.` prefix so independent fragments compose without name clashes);
//   • collision-as-error (the same top-level name from two DIFFERENT files);
//   • structured failure reporting (`ImportResolutionError`) instead of raw throws.

import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import type * as AST from '../parser/ast'

/**
 * A file reader function — abstracted for testability.
 * In real usage, reads from filesystem. In tests, can be mocked.
 */
export type FileReader = (path: string) => string | null

export interface ResolveImportsOptions {
  /** Output collector for inline GeoJSON `source.data` objects found
   *  inside imported Mapbox styles. Keyed by `sanitizeId(sourceId)`.
   *  The runtime consumes this after sources finish loading and
   *  seeds `rawDatasets` directly — no manual `setSourceData()`. */
  inlineGeoJSON?: Map<string, unknown>
  /** #1112 — out-collector for the imported style's top-level `sprite` URL.
   *  Forwarded verbatim to `convertMapboxStyle`, which fills it (the emitted
   *  DSL never carries `sprite`). The runtime reads it after resolution to
   *  wire the sprite atlas the `import "url"` path would otherwise drop —
   *  icon-image layers (road_oneway arrows, POI, shields) render nothing
   *  without it. Mirrors `inlineGeoJSON`. */
  topLevel?: { sprite?: string }
}

/**
 * Structured import-resolution failure. Carries a machine-readable `detail` so
 * the in-flight diagnostics-channel migration (#1065) can map these onto the
 * shared Diagnostic surface mechanically; the human `message` keeps the legacy
 * "Could not read file" substring existing callers/tests match on.
 */
export class ImportResolutionError extends Error {
  constructor(
    message: string,
    readonly detail:
      | { code: 'MISSING_FILE'; path: string; importer: string; line: number }
      | { code: 'IMPORT_CYCLE'; chain: string[] }
      | { code: 'NAME_COLLISION'; name: string; origins: [string, string] },
  ) {
    super(message)
    this.name = 'ImportResolutionError'
  }
}

/** Importer label for a top-level import in the entry program (which has no
 *  file path of its own — the caller passed an already-parsed AST). */
const ENTRY = '<entry>'

function missingFileError(path: string, importer: string, line: number): ImportResolutionError {
  return new ImportResolutionError(
    `[Module] Could not read file "${path}" (imported by ${importer} at line ${line})`,
    { code: 'MISSING_FILE', path, importer, line },
  )
}

function cycleError(chain: string[]): ImportResolutionError {
  return new ImportResolutionError(`[Module] Import cycle detected: ${chain.join(' -> ')}`, {
    code: 'IMPORT_CYCLE',
    chain,
  })
}

function collisionError(name: string, a: string, b: string): ImportResolutionError {
  return new ImportResolutionError(
    `[Module] Duplicate top-level name "${name}" imported from both "${a}" and "${b}" — ` +
      `namespace one with \`import * as ns from "..."\` or rename it`,
    { code: 'NAME_COLLISION', name, origins: [a, b] },
  )
}

/** Shared mutable state threaded through one resolve. `resolved` is both the
 *  cycle-partner memo (a file resolved once is never re-spliced — diamond dedup)
 *  and the existing same-file dedup; `nameOrigins` keys every spliced top-level
 *  definition by `kind:name` → its origin file for cross-file collision checks. */
interface ResolveState {
  resolved: Set<string>
  nameOrigins: Map<string, string>
  imported: AST.Statement[]
  options?: ResolveImportsOptions
}

function isCherryPick(stmt: AST.ImportStatement): boolean {
  return stmt.names.length > 0 && stmt.namespace === undefined
}

/**
 * Resolve all imports in a program, merging imported symbols.
 * Returns a new program with imported statements prepended (dependency order:
 * a deep import lands before the file that imports it).
 */
export function resolveImports(
  program: AST.Program,
  basePath: string,
  readFile: FileReader,
  options?: ResolveImportsOptions,
): AST.Program {
  const state: ResolveState = {
    resolved: new Set(),
    nameOrigins: new Map(),
    imported: [],
    options,
  }

  for (const stmt of program.body) {
    if (stmt.kind !== 'ImportStatement') continue
    const filePath = resolveFilePath(stmt.path, basePath)
    if (isCherryPick(stmt)) {
      cherryPickSync(filePath, stmt.names, ENTRY, stmt.line, readFile, state)
    } else {
      resolveFileSync(filePath, stmt.namespace, ENTRY, stmt.line, [], readFile, state)
    }
  }

  const body = [...state.imported, ...program.body.filter((s) => s.kind !== 'ImportStatement')]
  return { kind: 'Program', body }
}

/** Recursively resolve a splice / namespaced-splice import. Depth-first: a file's
 *  own nested imports are resolved (and spliced) BEFORE its own statements, so
 *  base defs precede the fragment that builds on them. */
function resolveFileSync(
  filePath: string,
  namespace: string | undefined,
  importer: string,
  importLine: number,
  stack: string[],
  readFile: FileReader,
  state: ResolveState,
): void {
  // Cycle check runs BEFORE the memo: a file currently on the stack is also in
  // `resolved` (added on entry below), so checking the memo first would silently
  // swallow the cycle instead of reporting it.
  if (stack.includes(filePath)) throw cycleError([...stack, filePath])
  if (state.resolved.has(filePath)) return

  const source = readFile(filePath)
  if (source == null) throw missingFileError(filePath, importer, importLine)
  state.resolved.add(filePath)

  const moduleAst = parseModuleSource(source, state.options)
  const childStack = [...stack, filePath]

  for (const stmt of moduleAst.body) {
    if (stmt.kind !== 'ImportStatement') continue
    const childPath = resolveFilePath(stmt.path, filePath)
    if (isCherryPick(stmt)) {
      cherryPickSync(childPath, stmt.names, filePath, stmt.line, readFile, state)
    } else {
      resolveFileSync(childPath, stmt.namespace, filePath, stmt.line, childStack, readFile, state)
    }
  }

  const own = moduleAst.body.filter((s) => s.kind !== 'ImportStatement')
  spliceStatements(own, filePath, namespace, state)
}

/** Cherry-pick import (`import { a, b } from "..."`): flat, non-recursive, name-
 *  filtered — matches the established v1 semantics (and its same-file dedup). */
function cherryPickSync(
  filePath: string,
  names: string[],
  importer: string,
  importLine: number,
  readFile: FileReader,
  state: ResolveState,
): void {
  if (state.resolved.has(filePath)) return
  const source = readFile(filePath)
  if (source == null) throw missingFileError(filePath, importer, importLine)
  state.resolved.add(filePath)

  const moduleAst = parseModuleSource(source, state.options)
  const picked = moduleAst.body.filter((s) => {
    const n = getStatementName(s)
    return n !== null && names.includes(n)
  })
  spliceStatements(picked, filePath, undefined, state)
}

/**
 * Async file reader — the browser uses fetch() which is always async.
 * Returning null signals "file not found" and raises a helpful error.
 */
export type AsyncFileReader = (path: string) => Promise<string | null>

/**
 * Async variant of resolveImports — uses an async file reader so the browser
 * can fetch() imported files over HTTP. Behaviourally identical to the sync
 * version, just awaiting each read.
 */
export async function resolveImportsAsync(
  program: AST.Program,
  basePath: string,
  readFile: AsyncFileReader,
  options?: ResolveImportsOptions,
): Promise<AST.Program> {
  const state: ResolveState = {
    resolved: new Set(),
    nameOrigins: new Map(),
    imported: [],
    options,
  }

  for (const stmt of program.body) {
    if (stmt.kind !== 'ImportStatement') continue
    const filePath = resolveFilePath(stmt.path, basePath)
    if (isCherryPick(stmt)) {
      await cherryPickAsync(filePath, stmt.names, ENTRY, stmt.line, readFile, state)
    } else {
      await resolveFileAsync(filePath, stmt.namespace, ENTRY, stmt.line, [], readFile, state)
    }
  }

  const body = [...state.imported, ...program.body.filter((s) => s.kind !== 'ImportStatement')]
  return { kind: 'Program', body }
}

async function resolveFileAsync(
  filePath: string,
  namespace: string | undefined,
  importer: string,
  importLine: number,
  stack: string[],
  readFile: AsyncFileReader,
  state: ResolveState,
): Promise<void> {
  if (stack.includes(filePath)) throw cycleError([...stack, filePath])
  if (state.resolved.has(filePath)) return

  const source = await readFile(filePath)
  if (source == null) throw missingFileError(filePath, importer, importLine)
  state.resolved.add(filePath)

  const moduleAst = parseModuleSource(source, state.options)
  const childStack = [...stack, filePath]

  for (const stmt of moduleAst.body) {
    if (stmt.kind !== 'ImportStatement') continue
    const childPath = resolveFilePath(stmt.path, filePath)
    if (isCherryPick(stmt)) {
      await cherryPickAsync(childPath, stmt.names, filePath, stmt.line, readFile, state)
    } else {
      await resolveFileAsync(
        childPath,
        stmt.namespace,
        filePath,
        stmt.line,
        childStack,
        readFile,
        state,
      )
    }
  }

  const own = moduleAst.body.filter((s) => s.kind !== 'ImportStatement')
  spliceStatements(own, filePath, namespace, state)
}

async function cherryPickAsync(
  filePath: string,
  names: string[],
  importer: string,
  importLine: number,
  readFile: AsyncFileReader,
  state: ResolveState,
): Promise<void> {
  if (state.resolved.has(filePath)) return
  const source = await readFile(filePath)
  if (source == null) throw missingFileError(filePath, importer, importLine)
  state.resolved.add(filePath)

  const moduleAst = parseModuleSource(source, state.options)
  const picked = moduleAst.body.filter((s) => {
    const n = getStatementName(s)
    return n !== null && names.includes(n)
  })
  spliceStatements(picked, filePath, undefined, state)
}

/** Auto-detect Mapbox style.json (a JSON object with `version` and `layers` is
 *  the spec shape — detected BEFORE parsing because raw style.json doesn't lex
 *  as xgis), converting it to xgis source first, then lex + parse.
 *
 *  `Parser.parse()` consumes the mandatory `xgis <major>` version pragma (#1064)
 *  as part of parsing; it never enters `moduleAst.body`. So splicing a module's
 *  body can NEVER carry a pragma into the host program (a spliced pragma mid-file
 *  would hard-error) — pragma-strip is by construction, at every recursion depth.
 *  `convertMapboxStyle` emits the pragma too, so converted styles pass the gate. */
function parseModuleSource(source: string, options?: ResolveImportsOptions): AST.Program {
  const xgisSource = looksLikeMapboxStyle(source)
    ? convertMapboxStyle(JSON.parse(source), options)
    : source
  const tokens = new Lexer(xgisSource).tokenize()
  return new Parser(tokens).parse()
}

/** Splice a module's (already namespace-rewritten) statements into the shared
 *  accumulator, enforcing cross-file name collisions. Two DIFFERENT files
 *  contributing the same `kind:name` is an error naming both origins; the same
 *  file re-contributing is impossible (the `resolved` memo skips it — the
 *  diamond case). The root program's own names are intentionally NOT registered:
 *  imports are prepended and the root follows, so the root may override. */
function spliceStatements(
  statements: AST.Statement[],
  originFile: string,
  namespace: string | undefined,
  state: ResolveState,
): void {
  const out = namespace ? applyNamespace(statements, namespace) : statements
  for (const stmt of out) {
    const name = definitionName(stmt)
    if (name !== null) {
      const key = `${stmt.kind}:${name}`
      const prev = state.nameOrigins.get(key)
      if (prev !== undefined && prev !== originFile) {
        throw collisionError(name, prev, originFile)
      }
      state.nameOrigins.set(key, originFile)
    }
    state.imported.push(stmt)
  }
}

/** Every named top-level definition kind — the collision surface. Broader than
 *  `getStatementName` (which drives cherry-pick and deliberately omits layer /
 *  keyframes) because a duplicate LAYER or KEYFRAMES name across two fragments
 *  is just as much a clash as a duplicate source or preset. */
function definitionName(stmt: AST.Statement): string | null {
  switch (stmt.kind) {
    case 'SourceStatement':
    case 'LayerStatement':
    case 'PresetStatement':
    case 'KeyframesStatement':
    case 'SymbolStatement':
      return stmt.name
    default:
      return null
  }
}

/**
 * Rename a namespaced module's block-level definitions to `ns.name` and rewrite
 * their intra-module references so the module stays self-consistent under the
 * prefix. This is what `import * as ns from "..."` qualifies — and, precisely,
 * what it does NOT:
 *
 *   QUALIFIED: `source`, `layer`, `preset`, `keyframes` definitions, plus their
 *     block-level wiring — a layer's `source:` identifier, `apply-<preset>` and
 *     `animation-<keyframes>` utilities. Reference rewrites are gated on the
 *     module's OWN local names, so a global utility (`fill-red-500`) or a host
 *     preset never gets touched.
 *
 *   GLOBAL (never prefixed): utility classes (`fill-*`, `stroke-*`, `opacity-*`,
 *     …), data-field access (`.prop`), reserved eval keys (`$zoom`, `$pitch`, …),
 *     colors, and `symbol` definitions — the latter are referenced from shape
 *     slots (a separate, larger surface) and carry zero corpus usage, so leaving
 *     them global costs nothing and never silently breaks a namespaced module.
 *
 * The purpose is collision-free COMPOSITION: two fragments that each define
 * `layer roads` splice cleanly as `a.roads` and `b.roads`. (Host → imported
 * cross-references — a root layer written as `source: ns.world` — are out of
 * scope for v1; they would require the IR reference sites to accept qualified
 * names, a separately-owned surface.)
 */
function applyNamespace(statements: AST.Statement[], ns: string): AST.Statement[] {
  const localSources = new Set<string>()
  const localPresets = new Set<string>()
  const localKeyframes = new Set<string>()
  for (const s of statements) {
    if (s.kind === 'SourceStatement') localSources.add(s.name)
    else if (s.kind === 'PresetStatement') localPresets.add(s.name)
    else if (s.kind === 'KeyframesStatement') localKeyframes.add(s.name)
  }
  const q = (name: string): string => `${ns}.${name}`

  return statements.map((s): AST.Statement => {
    switch (s.kind) {
      case 'SourceStatement':
        return { ...s, name: q(s.name) }
      case 'KeyframesStatement':
        return { ...s, name: q(s.name) }
      case 'PresetStatement':
        return {
          ...s,
          name: q(s.name),
          utilities: namespaceUtilityLines(s.utilities, ns, localPresets, localKeyframes),
        }
      case 'LayerStatement': {
        const properties = s.properties.map((p) =>
          p.name === 'source' && p.value.kind === 'Identifier' && localSources.has(p.value.name)
            ? { ...p, value: { ...p.value, name: q(p.value.name) } }
            : p,
        )
        return {
          ...s,
          name: q(s.name),
          properties,
          utilities: namespaceUtilityLines(s.utilities, ns, localPresets, localKeyframes),
        }
      }
      default:
        return s
    }
  })
}

function namespaceUtilityLines(
  lines: AST.UtilityLine[],
  ns: string,
  localPresets: Set<string>,
  localKeyframes: Set<string>,
): AST.UtilityLine[] {
  return lines.map((line) => ({
    ...line,
    items: line.items.map((item) => namespaceUtilityItem(item, ns, localPresets, localKeyframes)),
  }))
}

/** Rewrite a single utility item's reference to a local preset / keyframes.
 *  Only `apply-<preset>` and `animation-<keyframes>` name module symbols; the
 *  membership gate keeps every other utility (`fill-red-500`, `animation-ease-in`)
 *  and any modifier-carrying item untouched. */
function namespaceUtilityItem(
  item: AST.UtilityItem,
  ns: string,
  localPresets: Set<string>,
  localKeyframes: Set<string>,
): AST.UtilityItem {
  if (item.modifier) return item
  if (item.name.startsWith('apply-')) {
    const target = item.name.slice('apply-'.length)
    if (localPresets.has(target)) return { ...item, name: `apply-${ns}.${target}` }
  } else if (item.name.startsWith('animation-')) {
    const target = item.name.slice('animation-'.length)
    if (localKeyframes.has(target)) return { ...item, name: `animation-${ns}.${target}` }
  }
  return item
}

/** Cherry-pick name coverage: which statement kinds `import { name } from "..."`
 *  can select. Unchanged from v1 (layer / keyframes are addressed by the broader
 *  `definitionName` for collision purposes only). */
function getStatementName(stmt: AST.Statement): string | null {
  switch (stmt.kind) {
    case 'PresetStatement':
      return stmt.name
    case 'SourceStatement':
      return stmt.name
    case 'SymbolStatement':
      return stmt.name
    default:
      return null
  }
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
    return (
      j !== null &&
      typeof j === 'object' &&
      typeof j.version === 'number' &&
      j.version >= 7 &&
      Array.isArray(j.layers)
    )
  } catch {
    return false
  }
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

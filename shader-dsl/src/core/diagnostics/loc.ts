// ═══ Shader DSL — source-location capture (dev-only, opt-in) ═══
//
// Maps an authored IR node (a Stmt or a FuncDecl) back to the TypeScript line that
// produced it, so a diagnostic can point at `file:line:col` instead of just a fn name.
//
// THREE invariants make this safe:
//   1. Locations live in a module-private WeakMap keyed by node OBJECT IDENTITY — they
//      are NOT fields on the frozen IR shapes, so the emit tree-walk never sees them and
//      the emitted WGSL/GLSL bytes are unchanged.
//   2. Lookups are only valid on the AUTHORED module — autoVars/lowerModule/cse rebuild
//      every node ({...}-spread), breaking identity. validate()/lintModule()/diagnose()
//      all run BEFORE those passes, which is exactly where we read locations.
//   3. Capture is OFF by default and genuinely zero-cost when off: captureLoc() returns
//      before allocating `new Error()`, so no stack string is ever materialised.

import type { SourceLoc } from './error'

// The package declares no ambient node types (tsconfig `types: []`), so reach `process`
// via globalThis — present under node/bun, absent in the browser build (→ tracing off).
const _env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
let tracing = _env?.XGIS_SHADER_DSL_TRACE === '1'

/** Turn authored-source tracing on/off. Default OFF (honours XGIS_SHADER_DSL_TRACE=1). */
export const setSourceTracing = (on: boolean): void => {
  tracing = on
}
export const isSourceTracing = (): boolean => tracing

const locTable = new WeakMap<object, SourceLoc>()

// A V8 frame: `    at fnName (/path/file.ts:12:34)` or `    at /path/file.ts:12:34`.
// Spidermonkey/JSC: `fnName@/path/file.ts:12:34`. One regex covers the `file:line:col`
// tail of both; we only need the last three groups.
const FRAME = /(?:\(|@|\s)([^()@\s]+):(\d+):(\d+)\)?\s*$/

/** Capture the first stack frame OUTSIDE this package — the author's call site. Returns
 *  undefined when tracing is off (no `new Error()` allocated) or no external frame is found. */
export function captureLoc(): SourceLoc | undefined {
  if (!tracing) return undefined
  const stack = new Error().stack
  if (!stack) return undefined
  for (const raw of stack.split('\n')) {
    const m = FRAME.exec(raw)
    if (!m) continue
    const file = m[1]
    // Skip node internals, anonymous frames, and this package's OWN implementation
    // source — but NOT a co-located *.test.ts, which authors shaders like a consumer
    // (real consumers live outside core/, so this only matters for the package's tests).
    if (file.startsWith('node:') || !file.includes('/')) continue
    if (file.includes('/shader-dsl/src/core/') && !file.endsWith('.test.ts')) continue
    return { file, line: Number(m[2]), col: Number(m[3]) }
  }
  return undefined
}

/** Stamp a node with its authored location (no-op when loc is undefined → tracing off). */
export const recordLoc = (node: object, loc: SourceLoc | undefined): void => {
  if (loc) locTable.set(node, loc)
}

/** The authored location of a node, if one was captured (tracing was on at author time
 *  AND `node` is the original authored object, not a post-lowering rebuild). */
export const getLoc = (node: object): SourceLoc | undefined => locTable.get(node)

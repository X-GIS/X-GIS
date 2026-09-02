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

import type { SourceLoc } from './error.js'

// The package declares no ambient node types (tsconfig `types: []`), so reach `process`
// via globalThis — present under node/bun, absent in the browser build (→ tracing off).
const _env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
let tracing = _env?.XGIS_SHADER_DSL_TRACE === '1'

/** Turn authored-source tracing on/off. Default OFF (honours XGIS_SHADER_DSL_TRACE=1). */
export const setSourceTracing = (on: boolean): void => {
  tracing = on
}
/** Whether authored-source tracing is currently on — the read half of
 *  {@link setSourceTracing}.
 *
 *  Exported for this package's own tests and for `captureLoc`'s early-out, not as a switch a
 *  consumer branches on: a diagnostic already tells you whether it resolved a location by
 *  whether its `loc` is present, which is the question worth asking and is correct even when
 *  tracing was toggled between authoring and reporting. Use {@link setSourceTracing} to turn it
 *  on (or `XGIS_SHADER_DSL_TRACE=1`).
 *
 *  @internal
 */
export const isSourceTracing = (): boolean => tracing

const locTable = new WeakMap<object, SourceLoc>()

// A V8 frame: `    at fnName (/path/file.ts:12:34)` or `    at /path/file.ts:12:34`.
// Spidermonkey/JSC: `fnName@/path/file.ts:12:34`. One regex covers the `file:line:col`
// tail of both; we only need the last three groups.
const FRAME = /(?:\(|@|\s)([^()@\s]+):(\d+):(\d+)\)?\s*$/

/** This package's own implementation root, as a path fragment every internal frame contains —
 *  DERIVED from this module's URL at load time rather than hardcoded, so the filter tracks
 *  wherever the package is actually served from: a checkout's `src/core/`, a published
 *  `dist/core/`, any `node_modules` install path, a Vite `/@fs/` dev URL. The literal
 *  `/shader-dsl/src/core/` it used to hardcode only ever matched a source checkout, so a
 *  consumer running built JS got this package's OWN frames reported as author locations.
 *
 *  This file is `<root>/core/diagnostics/loc.ts`, so its grandparent IS that root — the one
 *  fact this module may assume about itself. `loc.test.ts` pins it: move this file and the
 *  test names the line to change.
 *
 *  @internal
 */
export const CORE_PREFIX: string = ((): string => {
  const url = (import.meta as { url?: string }).url
  // No import.meta (a CJS transpile) — fall back to the pre-derivation literal, which is
  // still correct for a source checkout.
  if (!url) return '/shader-dsl/src/core/'
  // `file:///a/b/c.ts` → `/a/b/c.ts`; an http(s) dev-server URL keeps its origin, and both
  // shapes are compared by CONTAINMENT below, so the two never have to agree on a scheme.
  const path = (url.startsWith('file://') ? url.slice('file://'.length) : url).split(/[?#]/)[0]!
  const dir = path.slice(0, path.lastIndexOf('/')) // …/core/diagnostics
  return dir.slice(0, dir.lastIndexOf('/') + 1) // …/core/
})()

/** Whether a stack frame's file belongs to this package's own implementation — the frames
 *  `captureLoc` must skip to reach the author's call site. A co-located `*.test.ts` is NOT
 *  internal: it authors shaders like a consumer would (real consumers live outside `core/`,
 *  so this only matters for the package's own tests).
 *
 *  `corePrefix` is a parameter so the classifier can be tested against layouts this process
 *  is not running from (a `dist/` build, an install path).
 *
 *  @internal
 */
export const isInternalFrame = (file: string, corePrefix: string = CORE_PREFIX): boolean =>
  file.includes(corePrefix) && !file.endsWith('.test.ts')

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
    // Skip node internals and anonymous frames, then this package's own source.
    if (file.startsWith('node:') || !file.includes('/')) continue
    if (isInternalFrame(file)) continue
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

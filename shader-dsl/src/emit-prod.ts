// ═══ Shader DSL — production-emit plugins (`@xgis/shader-dsl/emit-prod`) ═══
//
// Ship-time transforms for the emitted shader text, composed the Vite/Webpack
// way: each transform is a named EmitPlugin, and you pass a `{ plugins: [...] }`
// bag to the emit call. Deliberately on its OWN subpath — the core emit path
// carries only the neutral plugin seam, so a runtime-emit consumer that never
// imports this module bundles ZERO bytes of it. This is where the
// production-emit axis grows (a forced-inline plugin is the planned next
// resident); the main barrel stays runtime-only, the same split
// `@xgis/shader-dsl/dev` made for the lint/measure tooling (#740 R2b).
//
// Typical build-time use:
//
//   import { obfuscate, decodeShaderLog } from '@xgis/shader-dsl/emit-prod'
//   const renames = new Map<string, string>()
//   const fs = emitGlslModule(m, 'fragment', {
//     parens: 'minimal',
//     plugins: obfuscate({ renames }),
//   })
//   // …keep `renames` out of the bundle; it is what turns a shipped driver
//   // error back into authored names:
//   console.error(decodeShaderLog(info.messages[0].message, renames))
//
// Every renderable example is compiled AND pixel-compared through obfuscate()
// on real Tint + ANGLE by playground/e2e/_emit-obfuscate-gate.spec.ts.

import type { EmitPlugin } from './core/emit.js'
import { mangleModule } from './core/passes/mangle.js'
import { minifyShaderText, type MinifyOptions } from './core/emit-minify.js'
import { aliasShaderTypes } from './core/emit-alias.js'
import { pruneRedundantPrototypes } from './core/emit-prune.js'
import { forceInline as inlineModule, type InlineOpaque } from './core/passes/force-inline.js'

export type { EmitPlugin, EmitOptions } from './core/emit.js'
export { minifyShaderText, type MinifyOptions } from './core/emit-minify.js'
export { aliasShaderTypes } from './core/emit-alias.js'
export { pruneRedundantPrototypes } from './core/emit-prune.js'
export { decodeShaderLog, invertRenames, type DecodedName } from './core/decode-log.js'
export { mangleModule, type MangleResult } from './core/passes/mangle.js'
export type { InlineOpaque } from './core/passes/force-inline.js'

/** Identifier-mangling plugin (a Vite-style factory returning an EmitPlugin).
 *  Renames the authored vocabulary — helper fns, plain structs, module consts
 *  (incl. the injected df64_* library) — to _f0/_S0/_k0; the ABI boundary (entry
 *  names, binding names incl. the `_fp64` guard, binding-struct/UBO block tags,
 *  struct field names) is never touched, so reflection-driven hosts bind
 *  unchanged. Deterministic per module (declaration order), which the GLSL
 *  two-stage link relies on. Pass a Map to receive authored → emitted names (the
 *  shader "source map" for decoding production driver logs). */
export function mangle(opts?: { renames?: Map<string, string> }): EmitPlugin {
  return {
    name: 'mangle',
    transformIR: (lowered) => {
      const r = mangleModule(lowered)
      if (opts?.renames) for (const [from, to] of r.renames) opts.renames.set(from, to)
      return r.module
    },
  }
}

/** Text-minification plugin: whitespace/comment compaction of the emitted
 *  string, plus lossless numeric-literal canonicalisation (`1.0` → `1.`; pass
 *  `{ numbers: false }` to keep the literals as emitted). The minifier LEXES
 *  the text and writes a separator only where maximal munch would otherwise
 *  merge two tokens, so it is token-safe by construction — a property the
 *  example corpus asserts directly (examples/minify-safety.test.ts) and real
 *  Tint + ANGLE confirm (_emit-obfuscate-gate.spec.ts). */
export function minify(opts?: MinifyOptions): EmitPlugin {
  return { name: 'minify', transformText: (code) => minifyShaderText(code, opts) }
}

/** Call-graph-flattening plugin (obfuscation): inlines every safely-inlinable helper
 *  at all its call sites, so those functions vanish from the output — single-return
 *  helpers by expression substitution, and SINGLE-EXIT multi-statement helpers by
 *  lifting their statements into the caller. The prelude may contain control flow;
 *  what is refused is a second exit, a `break`/`continue` that would bind to the
 *  caller's loop, `discard` (impure), and `raw` — see `preludeBlocker`. Entry points
 *  and recursive fns are always left intact.
 *
 *  NOT a size win (a multi-call helper is duplicated at each site; the point is
 *  removing structure a reader could follow — pair it with mangle() + minify()).
 *  Duplicated TEXT, though, is not duplicated WORK: flattening is followed by a
 *  bit-exact re-hoisting pass (#1860), so a value N inlined copies derive from the
 *  same argument is still computed ONCE.
 *
 *  `opaque` is the ONE axis this plugin has, and its three values are a monotone
 *  ladder — each does everything the one before it does, plus more. It decides what
 *  happens to `FuncDecl.opaque`, the function-granular do-not-optimize flag that
 *  `fp64Lower` stamps on the df64 emulation library (#1926):
 *
 *   • `'keep'` (default) — opaque helpers are never touched. Safe, and a measured
 *     complete NO-OP on every fp64 example: 39 of 39 emitted sources byte-identical
 *     across WGSL and both GLSL stages, because the df64 library is all there is to
 *     inline there. Non-fp64 examples move by −56 B to +9601 B.
 *   • `'single-call'` — additionally unlocks opaque helpers with exactly ONE call
 *     site, where removing the decl plus its single call duplicates nothing.
 *     Measured on the fp64 corpus: 2-5 fewer functions per example, −5% to +8% bytes.
 *   • `'all'` — unlocks every opaque helper, so `df64_*` leaves the output entirely
 *     and the call graph really does disappear. Costs **5.1x to 27.2x** the emitted
 *     bytes (fp64-sine-sweep 6,266 B → 170,419 B), and `core/fp64/flavor-select.ts`
 *     records that FXC's compile cost on FULLY-INLINED df64 bodies can TDR on
 *     ANGLE-D3D11. Reach for it when unreadable output is worth those two costs.
 *
 *  Unlocking also runs the scalar-replacement cleanup (`memberFold`) and tree-shakes
 *  the emptied declarations, because both only have work to do once a df64 body has
 *  been flattened — `memberFold` fires 0 times under `'keep'` and 2,632 under `'all'`.
 *
 *  Values are unchanged at every setting: `core/passes/force-inline.test.ts` runs the
 *  df64 known-answer vectors through each policy under a correctly-rounding-f32 oracle
 *  and requires bit-equality with the un-inlined module. What that CANNOT see is a
 *  driver's fast-math — see the pass header.
 *
 *  Opt-in: NOT part of the obfuscate() preset, so no existing output changes. Runs in
 *  the IR stage, so place it before mangle() in the array. */
export function inline(opts?: { opaque?: InlineOpaque }): EmitPlugin {
  const opaque = opts?.opaque ?? 'keep'
  return { name: 'inline', transformIR: (m) => inlineModule(m, opaque) }
}

/** Type-name aliasing plugin: gives each heavily-used TYPE a one-character name
 *  and declares it once — WGSL `alias A=vec2<f32>;`, GLSL `#define A vec2` —
 *  then rewrites every spelling, constructor position included. Type names are
 *  the heaviest identifiers mangle may not touch (both languages reserve them),
 *  and after mangle they are the largest remaining category in the shipped text.
 *  Pays for itself per spelling or it is skipped, so a one-use type is left
 *  alone. Splices by token offset, so it composes in either order with
 *  minify(). Pass a Map as `renames` to receive `type -> alias` in the same
 *  authored → emitted direction mangle() reports, so one map decodes both. */
export function aliasTypes(opts?: { renames?: Map<string, string> }): EmitPlugin {
  return {
    name: 'alias-types',
    transformText: (code) => aliasShaderTypes(code, opts?.renames),
  }
}

/** Forward-prototype pruning plugin (GLSL only). Drops every prototype whose
 *  DEFINITION already declares the function at each of its uses, and keeps the
 *  rest. Since #1858 the GLSL backend topo-sorts its own fn section and emits a
 *  prototype only where the call graph forces one, so on backend-emitted shaders
 *  this finds nothing — measured on the map corpus: 0 of 74 GLSL sources altered,
 *  0.00% of the production-transformed text (#1914). It earns its place on the
 *  GLSL the backend did not author: hand-written `rawGlsl`, host-spliced
 *  fragments, and the backend's own `topo === null` fallback. No-op on WGSL. */
export function prune(): EmitPlugin {
  return { name: 'prune-prototypes', transformText: pruneRedundantPrototypes }
}

/** The standard production preset: [mangle, aliasTypes, minify] — rename the
 *  authored vocabulary, shorten the type vocabulary it may not rename, then
 *  compact with f32-exact literal re-spelling. Spread it into a `{ plugins }` bag —
 *  `emitModule(m, { parens: 'minimal', plugins: obfuscate({ renames }) })`. */
export function obfuscate(opts?: { renames?: Map<string, string> }): EmitPlugin[] {
  return [mangle(opts), prune(), aliasTypes(opts), minify({ numbers: 'f32' })]
}

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
import { inlineLinearAll } from './core/passes/inline-linear.js'

export type { EmitPlugin, EmitOptions } from './core/emit.js'
export { minifyShaderText, type MinifyOptions } from './core/emit-minify.js'
export { aliasShaderTypes } from './core/emit-alias.js'
export { pruneRedundantPrototypes } from './core/emit-prune.js'
export { decodeShaderLog, invertRenames, type DecodedName } from './core/decode-log.js'
export { mangleModule, type MangleResult } from './core/passes/mangle.js'

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

/** Call-graph-flattening plugin (obfuscation): inlines every safely-inlinable
 *  helper at all its call sites, so those functions vanish from the output —
 *  single-return helpers by expression substitution, and LINEAR multi-statement
 *  helpers (a `let`/`var` prelude + one trailing `return`, like a value-noise
 *  fn) by lifting their statements into the caller. Control-flow bodies, the
 *  df64 emulation library, entry points, and recursive fns are all left intact.
 *  NOT a size win (a multi-call helper is duplicated at each site; the point is
 *  removing structure a reader could follow — pair it with mangle() + minify()).
 *  Opt-in only; NOT part of the obfuscate() preset, so no existing output
 *  changes. Runs in the IR stage, so place it before mangle() in the array. */
export function inline(): EmitPlugin {
  return { name: 'inline', transformIR: inlineLinearAll }
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

/** Forward-prototype pruning plugin (GLSL only). The GLSL backend emits a
 *  prototype for EVERY helper because it cannot promise the function section is
 *  in dependency order; this drops the ones whose DEFINITION already declares
 *  the function at each of its uses, and keeps the rest. Worth its own pass: on
 *  the real map shader corpus — where a module drags in the df64 library and the
 *  projection graph — prototypes are 9.5% of the production-transformed text,
 *  a figure the toy examples hide almost entirely. No-op on WGSL. */
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

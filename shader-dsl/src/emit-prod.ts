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
//   import { mangle, minify, obfuscate } from '@xgis/shader-dsl/emit-prod'
//   const renames = new Map<string, string>()
//   const wgsl = emitModule(m, { plugins: [mangle({ renames }), minify()] })
//   // or the standard pair as a preset:
//   const fs = emitGlslModule(m, 'fragment', { plugins: obfuscate() })
//
// Every renderable example is compiled AND pixel-compared through obfuscate()
// on real Tint + ANGLE by playground/e2e/_emit-obfuscate-gate.spec.ts.

import type { EmitPlugin } from './core/emit'
import { mangleModule } from './core/passes/mangle'
import { minifyShaderText } from './core/emit-minify'
import { inlineLinearAll } from './core/passes/inline-linear'

export type { EmitPlugin, EmitOptions } from './core/emit'
export { minifyShaderText } from './core/emit-minify'
export { mangleModule, type MangleResult } from './core/passes/mangle'

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
 *  string. Token-safe by construction (WGSL/GLSL have no string literals; `#`
 *  directives keep their own line). */
export function minify(): EmitPlugin {
  return { name: 'minify', transformText: minifyShaderText }
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

/** The standard production preset: [mangle, minify]. Spread it into a
 *  `{ plugins }` bag — `emitModule(m, { plugins: obfuscate({ renames }) })`. */
export function obfuscate(opts?: { renames?: Map<string, string> }): EmitPlugin[] {
  return [mangle(opts), minify()]
}

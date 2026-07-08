// ═══ Shader DSL — production-emit tooling (`@xgis/shader-dsl/emit-prod`) ═══
//
// Ship-time transforms for the emitted shader text: minification and identifier
// mangling. Deliberately on its OWN subpath — the core emit path carries only
// the neutral EmitTransforms seam ({ transformIR, transformText }), so a
// runtime-emit consumer that never imports this module bundles ZERO bytes of
// it. This is where the production-emit axis grows (a forced-inline transform
// is the planned next resident); the main barrel stays runtime-only, the same
// split `@xgis/shader-dsl/dev` made for the lint/measure tooling (#740 R2b).
//
// Typical build-time use:
//
//   import { obfuscate } from '@xgis/shader-dsl/emit-prod'
//   const renames = new Map<string, string>()
//   const wgsl = emitModule(m, obfuscate({ renames }))
//   const fs = emitGlslModule(m, 'fragment', obfuscate())
//
// Every renderable example is compiled AND pixel-compared through obfuscate()
// on real Tint + ANGLE by playground/e2e/_emit-obfuscate-gate.spec.ts.

import type { EmitTransforms } from './core/emit'
import type { ModuleDecl } from './core/ir'
import { mangleModule } from './core/passes/mangle'
import { minifyShaderText } from './core/emit-minify'

export { minifyShaderText } from './core/emit-minify'
export { mangleModule, type MangleResult } from './core/passes/mangle'

/** The mangle side alone, as a transformIR. Renames the authored vocabulary
 *  (helper fns, plain structs, module consts — incl. the injected df64_*
 *  library) to _f0/_S0/_k0; the ABI boundary (entry names, binding names incl.
 *  the `_fp64` guard, binding-struct/UBO block tags, struct field names) is
 *  never touched, so reflection-driven hosts bind unchanged. Deterministic per
 *  module (declaration order), which the GLSL two-stage link relies on. Pass a
 *  Map to receive authored → emitted names (the shader "source map" for
 *  decoding production driver logs). */
export function mangleIR(renames?: Map<string, string>): (lowered: ModuleDecl) => ModuleDecl {
  return (lowered) => {
    const r = mangleModule(lowered)
    if (renames) for (const [from, to] of r.renames) renames.set(from, to)
    return r.module
  }
}

/** The full production bundle transform: mangle the lowered IR + minify the
 *  emitted text. Returns an EmitTransforms object to pass straight to
 *  emitModule / emitGlslModule. */
export function obfuscate(opts?: { renames?: Map<string, string> }): EmitTransforms {
  return { transformIR: mangleIR(opts?.renames), transformText: minifyShaderText }
}

import type { LintRule } from '../engine.js'
import { CODES } from '../../../diagnostics/codes.js'
import { analyzePortableKernel, isPortableComputeEntry } from '../../portable-kernel.js'

/** A `portable`-declared `@compute` entry must stay inside the gather-only tier (#1812).
 *
 *  `portable: true` is a promise that the kernel emits on BOTH backends — natively on WGSL
 *  and, on GLSL ES 3.00, through the compute→fragment-GPGPU lowering run with no emit option.
 *  This rule is what makes the promise checkable: it is registered in `CORE_RULES`, so
 *  `validate()` runs it at EVERY emit on BOTH writers, and a kernel that could never lower
 *  for WebGL2 therefore fails on WebGPU too — at authoring time, with the remedy — instead of
 *  passing every WGSL gate and dying only on the backend the author was not looking at.
 *
 *  The shape itself is NOT decided here: `passes/portable-kernel.ts`'s `analyzePortableKernel`
 *  is its single authority (the GLSL lowering calls the same function), and each violation it
 *  returns is already a complete detail+remedy sentence, reported verbatim as `SD0111`. One
 *  diagnostic per violation, so a kernel that breaks the tier in three ways reports all three
 *  rather than one-per-emit.
 *
 *  A module with no portable entry is silent by construction — the declaration is the only
 *  trigger, which is exactly why the tier is DECLARED rather than inferred (#1812: an inferred
 *  tier drifts silently the moment a kernel gains a non-portable construct). */
export const portableKernel: LintRule = {
  id: 'portable-kernel',
  description: 'a portable-declared compute entry must stay inside the gather-only tier',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      if (!isPortableComputeEntry(f)) return
      const result = analyzePortableKernel(ctx.module, f)
      if (result.ok) return
      for (const violation of result.violations)
        ctx.report(violation, { fn: f.name, node: f, code: 'SD0111', hint: CODES.SD0111.hint })
    },
  }),
}

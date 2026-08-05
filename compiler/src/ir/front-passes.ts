// ═══ Front passes — whole-program checks and rewrites before lowering ═══
//
// One ordered pipeline, run once at the top of `lower()`. Each pass reads
// (and `inlineUserFns` rewrites) the parsed program before any statement is
// lowered, so the lowering loops below it only ever see a validated,
// fn-free program. Extracted from lower.ts so this list can grow without
// pressing that file's LOC ceiling.
//
// ORDER IS LOAD-BEARING:
//   0. resolveInputs     — `input` references (#1539) become a distinct
//                          `InputRef` node BEFORE anything else runs, so
//                          validateFnCalls/inlineUserFns/classify/codegen
//                          never see a bare Identifier that means "read
//                          a host-settable uniform" (mirrors why
//                          inlineUserFns resolves fn calls away first).
//   1. validateFnCalls   — unknown callees (#1066) are caught on the
//                          AUTHORED program, so a diagnostic names what the
//                          user wrote, not an inlined copy of it.
//   2. inlineUserFns     — user-fn calls are rewritten away (#1535), so
//                          classify / evaluator / codegen never see one.
//   3. validateBindingTypes — vector-in-scalar-position (#1537) is checked
//                          AFTER inlining, so a vec arriving through an fn
//                          body is caught at the binding that used it.
//   4. validateSchemaFields — `.field` access against a source's declared
//                          struct (#1537), likewise post-inlining.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { resolveInputs, type ResolvedInputInfo } from './resolve-inputs'
import { validateFnCalls } from './validate-fncalls'
import { inlineUserFns } from './fn-inline'
import { validateBindingTypes } from './expr-type'
import { validateSchemaFields } from './validate-schema-fields'

/**
 * Run every whole-program pass, returning the (possibly rewritten) program
 * plus the resolved `input` table. Diagnostics accumulate on the shared
 * lower channel.
 */
export function runFrontPasses(
  program: AST.Program,
  diagnostics: Diagnostic[],
): { program: AST.Program; inputs: ResolvedInputInfo[] } {
  const { program: resolved, inputs } = resolveInputs(program, diagnostics)
  validateFnCalls(resolved, diagnostics)
  const inlined = inlineUserFns(resolved, diagnostics)
  validateBindingTypes(inlined, diagnostics)
  validateSchemaFields(inlined, diagnostics)
  return { program: inlined, inputs }
}

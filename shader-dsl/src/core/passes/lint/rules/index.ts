// ═══ Shader DSL — lint rule registry ═══
//
// One rule per file in this folder. To add a rule (the 100th as easily as the 13th):
// create rules/<id>.ts exporting a LintRule, import it here, append it to RULES. The
// engine walks the IR once and dispatches to whichever handler each rule implements.

import type { LintRule } from '../engine.js'
import { dupStruct } from './dup-struct.js'
import { dupFunc } from './dup-func.js'
import { bindingCollision } from './binding-collision.js'
import { allPathsReturn } from './all-paths-return.js'
import { singleExit } from './single-exit.js'
import { mixedScalarRule } from './mixed-scalar.js'
import { noRecursion } from './no-recursion.js'
import { noUnreachable } from './no-unreachable-code.js'
import { noFloatEq } from './no-float-eq.js'
import { cyclomaticComplexity } from './cyclomatic-complexity.js'
import { paramCount } from './param-count.js'
import { namingConvention } from './naming-convention.js'
import { maxNesting } from './max-nesting-depth.js'
import { noSelfAssign } from './no-self-assign.js'
import { noAssignToLet } from './no-assign-to-let.js'
import { noEmptyFunction } from './no-empty-function.js'
import { maxFunctionLength } from './max-function-length.js'
import { preferLetOverVar } from './prefer-let-over-var.js'
import { noDeadBinding } from './no-dead-binding.js'
import { callSignature } from './call-signature.js'
import { smoothstepEdgeOrder } from './smoothstep-edge-order.js'
import { fragmentOnlyBuiltin } from './fragment-only-builtin.js'
import { portableKernel } from './portable-kernel.js'
import { noShadowedLocal } from './no-shadowed-local.js'

/** The registered ruleset. Order is the diagnostic order (module checks, then per-fn in
 *  declaration order). Append new rules here. */
export const RULES: readonly LintRule[] = [
  dupStruct,
  dupFunc,
  bindingCollision,
  allPathsReturn,
  singleExit,
  mixedScalarRule,
  noRecursion,
  noUnreachable,
  noFloatEq,
  cyclomaticComplexity,
  paramCount,
  namingConvention,
  maxNesting,
  noSelfAssign,
  noAssignToLet,
  noEmptyFunction,
  maxFunctionLength,
  preferLetOverVar,
  noDeadBinding,
  callSignature,
  smoothstepEdgeOrder,
  fragmentOnlyBuiltin,
  portableKernel,
  noShadowedLocal,
]

export {
  dupStruct,
  dupFunc,
  bindingCollision,
  allPathsReturn,
  singleExit,
  mixedScalarRule,
  noRecursion,
  noUnreachable,
  noFloatEq,
  cyclomaticComplexity,
  paramCount,
  namingConvention,
  maxNesting,
  noSelfAssign,
  noAssignToLet,
  noEmptyFunction,
  maxFunctionLength,
  preferLetOverVar,
  noDeadBinding,
  callSignature,
  smoothstepEdgeOrder,
  fragmentOnlyBuiltin,
  portableKernel,
  noShadowedLocal,
}

/** The subset run by validate() at EVERY emit (incl. runtime-composed + compute modules
 *  like eval_match): only the structural invariants that PROVABLY hold for any valid WGSL
 *  module — no opinionated style/control-flow rules. single-exit and the rest are
 *  LINT-ONLY (the shader static-analysis tests gate the shader modules), so an
 *  emit-time gate never false-flags a legitimately early-returning kernel. */
export const CORE_RULES: readonly LintRule[] = [
  dupStruct,
  dupFunc,
  bindingCollision,
  allPathsReturn,
  mixedScalarRule,
  // Call arity/types against the module's own fn decls — resolvable names only,
  // so composer-injected extern names can never false-flag (validate.ts charter).
  callSignature,
  // A fragment-only builtin in a vertex/compute entry is invalid WGSL for EVERY
  // module (no style opinion), and its native failure is an opaque driver error —
  // so it belongs at emit, not lint-only.
  fragmentOnlyBuiltin,
  // The portable kernel tier (#1812). CORE is the whole point: `portable: true` claims the
  // kernel emits on BOTH backends, so the claim must be checked at every emit on BOTH
  // writers — a lint-only gate would let a kernel that cannot lower for WebGL2 sail through
  // every WGSL path. Silent for any module that declares no portable entry.
  portableKernel,
  // The premise five optimizer passes rest on: within a function a binding is identified by
  // its NAME alone, so a duplicated name merges two bindings and const-prop / copy-prop /
  // dead-branch / member-fold / inline-linear move a value across a scope boundary it may not
  // cross. CORE because the failure is a SILENT miscompile on every backend — two sibling `if`
  // arms binding `t` folded to the same literal at O1 — not a style opinion (#2341).
  noShadowedLocal,
]

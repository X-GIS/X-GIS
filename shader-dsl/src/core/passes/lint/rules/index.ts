// ═══ Shader DSL — lint rule registry ═══
//
// One rule per file in this folder. To add a rule (the 100th as easily as the 13th):
// create rules/<id>.ts exporting a LintRule, import it here, append it to RULES. The
// engine walks the IR once and dispatches to whichever handler each rule implements.

import type { LintRule } from '../engine'
import { dupStruct } from './dup-struct'
import { dupFunc } from './dup-func'
import { bindingCollision } from './binding-collision'
import { allPathsReturn } from './all-paths-return'
import { singleExit } from './single-exit'
import { mixedScalarRule } from './mixed-scalar'
import { noRecursion } from './no-recursion'
import { noUnreachable } from './no-unreachable-code'
import { noFloatEq } from './no-float-eq'
import { cyclomaticComplexity } from './cyclomatic-complexity'
import { paramCount } from './param-count'
import { namingConvention } from './naming-convention'
import { maxNesting } from './max-nesting-depth'
import { noSelfAssign } from './no-self-assign'
import { noAssignToLet } from './no-assign-to-let'
import { noEmptyFunction } from './no-empty-function'
import { maxFunctionLength } from './max-function-length'
import { preferLetOverVar } from './prefer-let-over-var'
import { noDeadBinding } from './no-dead-binding'
import { callSignature } from './call-signature'
import { smoothstepEdgeOrder } from './smoothstep-edge-order'

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
]

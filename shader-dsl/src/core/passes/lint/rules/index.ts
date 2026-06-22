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
]

export {
  dupStruct, dupFunc, bindingCollision, allPathsReturn, singleExit, mixedScalarRule,
  noRecursion, noUnreachable, noFloatEq, cyclomaticComplexity, paramCount, namingConvention, maxNesting,
}

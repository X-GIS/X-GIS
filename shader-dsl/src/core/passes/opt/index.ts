// ═══ Shader DSL — Optimization context barrel ═══

export {
  optimize,
  fixpoint,
  optimizeAt,
  DEFAULT_PASSES,
  LEVEL_PASSES,
  type OptPass,
  type OptLevel,
} from './optimize.js'
export { constFold } from './const-fold.js'
export { constProp } from './const-prop.js'
export { copyProp } from './copy-prop.js'
export { deadBranch } from './dead-branch.js'
export { dce } from './dce.js'
export { deadFnElim } from './dce-fns.js'
export { gvn } from './gvn.js'
export { structCtor } from './struct-ctor.js'
export { algebraicSimplify } from './algebraic.js'
export { cse } from './cse.js'
export { cseLocal } from './cse-local.js'
export { autoVars } from './auto-vars.js'
export { licm } from './licm.js'
export { unrollLoops } from './unroll.js'
export { mapExpr, mapStmt, mapModuleExprs } from './ir-transform.js'

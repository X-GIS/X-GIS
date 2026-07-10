// ═══ Shader DSL — Optimization context barrel ═══

export {
  optimize,
  fixpoint,
  optimizeAt,
  DEFAULT_PASSES,
  LEVEL_PASSES,
  type OptPass,
  type OptLevel,
} from './optimize'
export { constFold } from './const-fold'
export { constProp } from './const-prop'
export { copyProp } from './copy-prop'
export { deadBranch } from './dead-branch'
export { dce } from './dce'
export { deadFnElim } from './dce-fns'
export { gvn } from './gvn'
export { algebraicSimplify } from './algebraic'
export { cse } from './cse'
export { cseLocal } from './cse-local'
export { autoVars } from './auto-vars'
export { licm } from './licm'
export { unrollLoops } from './unroll'
export { mapExpr, mapStmt, mapModuleExprs } from './ir-transform'

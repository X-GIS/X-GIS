// ═══ Shader DSL — Optimization context barrel ═══

export { optimize, fixpoint, DEFAULT_PASSES, type OptPass } from './optimize'
export { constFold } from './const-fold'
export { constProp } from './const-prop'
export { copyProp } from './copy-prop'
export { deadBranch } from './dead-branch'
export { dce } from './dce'
export { algebraicSimplify } from './algebraic'
export { cse } from './cse'
export { autoVars } from './auto-vars'
export { licm } from './licm'
export { mapExpr, mapStmt, mapModuleExprs } from './ir-transform'

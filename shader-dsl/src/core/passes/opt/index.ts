// ═══ Shader DSL — Optimization context barrel ═══

export { optimize, DEFAULT_PASSES, type OptPass } from './optimize'
export { constFold } from './const-fold'
export { dce } from './dce'
export { algebraicSimplify } from './algebraic'
export { cse } from './cse'
export { licm } from './licm'
export { mapExpr, mapStmt, mapModuleExprs } from './ir-transform'

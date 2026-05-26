// ═══ Shader DSL — IR barrel ═══
//
// The single import surface for the IR. ir.ts grew past ~580 LOC, so it was
// split by concern into types / nodes / node / builder (DAG: types ← nodes ←
// node ← builder). Import the IR via this barrel (`core/ir`), never the
// individual files.

export * from './types'
export * from './nodes'
export * from './node'
export * from './builder'

// TEMP re-export shim (US-R1). ir.ts was split by concern into core/ir/
// (types/nodes/node/builder + index barrel). This shim keeps every existing
// `./ir` importer working while US-R2 moves the rest of shader-dsl into
// core/+shaders/ and repoints consumers at the top-level barrel; it is removed
// in US-R2.
export * from './core/ir'

// @xgis/map public barrel. Re-exports content extracted from runtime/src/engine.
// During the incremental P3 Step 6 extraction this also surfaces internal symbols that
// still-in-runtime content imports cross-package; those are pruned to the public API in Step 8.
export * from './shaders/dsl'
// Builders the dsl/ index intentionally keeps private to dsl-internal consumers but which
// still-in-runtime content deep-imports during the incremental extraction (pruned in Step 8).
export * from './shaders/dsl/polygon'
export * from './shaders/dsl/oit-compose'
export * from './shaders/dsl/overdraw-fs'
export * from './render/globe-eye-uniform'

export * from './lexer'
export * from './parser'
// The language MAJOR version the parser gate + converter emitter agree on (#1064).
export { XGIS_LANGUAGE_MAJOR } from './language-version'
export * from './binary'
export * from './tokens'
export * from './ir'
export * from './eval'
// Format: the compile-time PARSE surface only. `./format` decodes a
// `{<expr>:<spec>}` template into IR (spec-parser + template-parser). The
// value-APPLY half (formatValue + the number/date/GIS formatters) relocated to
// @xgis/map in #1001 (runtime, co-located with text-resolver) — the compiler
// emits the FormatSpec, it does not render it. Explicit list (not `export *`)
// keeps the public parse set stable.
export { parseFormatSpec, parseTextTemplate, isBareExpressionTemplate } from './format'
export * from './module'
export * from './codegen'
export * from './tiler'
export * from './convert'
export * from './diagnostics'
export * from './schema'
// SceneBuilder — the imperative JS front-end to this compiler (#1194,
// docs/architecture/design/scene-builder.md). Constructs the parser's own
// Program AST behind the SceneProgram brand; consumed by map.runScene.
export * from './builder/scene-builder'

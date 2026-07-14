<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-23 -->

# module

## Purpose

The `.xgis` import resolver. Given a parsed `AST.Program`, it walks every `ImportStatement`, reads the referenced file via an injected reader, auto-detects Mapbox v8 `style.json` (running `convertMapboxStyle` before lexing), lexes + parses the result, then prepends the requested exported symbols into the caller's program body. File I/O is fully abstracted behind `FileReader` / `AsyncFileReader` interfaces so the resolver is testable without a real filesystem and usable in both Node.js (fs) and browser (fetch) hosts.

## Key Files

| File          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`    | Barrel re-export of `resolveImports`, `resolveImportsAsync`, `FileReader`, `AsyncFileReader`, and `ResolveImportsOptions` from `resolver.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `resolver.ts` | Exports `resolveImports` (sync) and `resolveImportsAsync` (async), plus the `FileReader`, `AsyncFileReader`, and `ResolveImportsOptions` types. Implements two import modes: cherry-pick (`import { name } from "path"`) and splice (`import "path"` with no names, inlines the entire file). Auto-detects Mapbox style JSON via `looksLikeMapboxStyle` heuristic; passes `options.inlineGeoJSON` map to `convertMapboxStyle` so inline `source.data` FeatureCollections are captured for the runtime to seed without a manual `setSourceData()` call. Deduplicates repeated imports from the same resolved path. |

## For AI Agents

### Working In This Directory

- File I/O is injected — never call `fs` or `fetch` directly here; that is the host's responsibility.
- Sync and async entry points must stay behaviourally identical; the async variant exists solely so browser hosts can `await fetch()`.
- `looksLikeMapboxStyle` does a cheap prefix check before a full `JSON.parse` to avoid expensive parsing of non-JSON content (e.g. an HTML 404 page served at a bad URL).
- Splice / namespaced-splice imports resolve RECURSIVELY (#1071): an imported file's own imports are resolved depth-first before its statements are spliced. A path-stack detects cycles (`ImportResolutionError` code `IMPORT_CYCLE`, naming the full chain); the `resolved` Set is the resolve-once memo (diamond dedup + the legacy same-file dedup). Cherry-pick (`import { a } from`) stays flat/non-recursive.
- Cross-file name collisions are errors (`ImportResolutionError` code `NAME_COLLISION`, naming both origins), keyed by `kind:name`. The root program's own names are NOT registered, so the root may override imported names. `import * as ns from "..."` namespaces the imported module's block-level defs (source/layer/preset/keyframes) under `ns.` and rewrites their intra-module refs (`source:`, `apply-`, `animation-`) — see `applyNamespace`; utility classes / data fields / colors / `let`·`fn`·`style`·`symbol` stay global.
- Failures throw `ImportResolutionError` carrying a discriminated `detail` (`MISSING_FILE` | `IMPORT_CYCLE` | `NAME_COLLISION`) — a thin surface the #1065 diagnostics-channel migration can remap mechanically; the `message` keeps the `Could not read file` substring callers match on.
- `resolveFilePath` normalises relative paths (`./`, `../`) against `basePath`; absolute or URL paths pass through unchanged.
- `getStatementName` covers: `PresetStatement`, `FnStatement`, `SourceStatement`, `LetStatement`, `SymbolStatement`, `StyleStatement` — the cherry-pick selection set. `definitionName` is the broader collision surface (adds `LayerStatement`, `KeyframesStatement`); any new named statement kind must be added to the relevant one.
- `inlineGeoJSON` key is the sanitised source id (underscores, not hyphens) — matches what `convertMapboxStyle` emits and what the runtime looks up in `rawDatasets`.

### Testing Requirements

- `compiler/src/__tests__/module.test.ts` — covers: parse of import syntax, cherry-pick resolution, splice form, Mapbox style auto-detect, inline GeoJSON collector, missing-file error, and same-file deduplication. Tests inject a `mockReader` record; no filesystem access.

### Common Patterns

- Dependency-inject the reader; call `new Lexer(...).tokenize()` then `new Parser(...).parse()` on the resolved source, matching the main compiler pipeline entry points.

## Dependencies

### Internal

- `../lexer/lexer` — tokenises imported file content.
- `../parser/parser` — parses token stream into `AST.Program`.
- `../convert/mapbox-to-xgis` — converts Mapbox v8 style JSON to `.xgis` source text before lexing.
- `../parser/ast` — `AST.Program` / `AST.Statement` types.

### External

- None (I/O is injected by the host).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

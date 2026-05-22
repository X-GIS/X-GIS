<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# module

## Purpose
The `import` statement resolver. Resolves an `.xgis` file's imports by reading the referenced files, parsing them, and extracting their exported symbols (presets, functions, etc.) for the importing module to use. File access is abstracted behind a `FileReader` / `AsyncFileReader` interface so the resolver is testable without a real filesystem (tests inject a mock; runtime injects fs/fetch).

## Key Files
| File | Description |
|------|-------------|
| `resolver.ts` | `resolveImports` / `resolveImportsAsync` + `FileReader`/`AsyncFileReader`/`ResolveImportsOptions`. Parses imported files and pulls out exported presets/functions/symbols. |

## For AI Agents

### Working In This Directory
- File I/O is injected via the `FileReader` abstraction — never call `fs` directly here; that keeps the compiler GPU-free AND fs-free for unit tests.
- Both sync and async entry points exist; keep their behavior identical (the async one exists for fetch-based hosts).
- Import order matters for symbol resolution (see `mapbox-import-order-regression.test.ts`).

### Testing Requirements
- `src/__tests__/module.test.ts` and `mapbox-import-order-regression.test.ts`. Tests mock the `FileReader`.

### Common Patterns
- Dependency injection of the reader; resolver re-uses `parser/` to parse referenced files.

## Dependencies

### Internal
- Imports `parser/`; consumed by the importer / host setup.

### External
- None (I/O injected).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

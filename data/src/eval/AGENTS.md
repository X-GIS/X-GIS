<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# eval

## Purpose

Expression evaluators that execute at MVT decode time inside the worker thread, before geometry is uploaded to the GPU. The two source files solve the overdraw problem and the extrude-height problem. For filters: many xgis layers share one MVT source layer with different `filter:` ASTs (e.g. six `landuse_*` layers on one `landuse` MVT layer); `filter-eval.ts` evaluates those ASTs per-feature to split the source layer into per-filter sub-slices keyed by a stable djb2 hash of the `(sourceLayer, filterAst)` pair — identical filters share a slice, so each GPU draw paints only matching features instead of the full layer. For extrude: `extrude-eval.ts` coerces per-feature height expressions to a finite positive number or `null` (fallback to layer default), injecting `$zoom`/`$geometryType`/`$featureId` reserved keys so zoom-interpolated heights resolve correctly at tile-decode time.

## Key Files

| File              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filter-eval.ts`  | `evalFilterExpr()`: evaluates a compiler AST against a feature property bag with per-feature throw isolation (throw → `false`, not tile crash). `computeSliceKey()`: memoised stable key for `(sourceLayer, filterAst)` pairs using `hashAstIterative()` — an explicit work-list djb2 hash that replaced a prior `JSON.stringify` path that stack-overflowed on 5000-node ASTs (iter-299). The WeakMap is keyed by AST object identity to a `Map<sourceLayer, key>`, dropping steady-state cost to one `Map.get` per call. Exports `ShowSlice` interface used by `map.ts` and the VTR to track per-show slice descriptors. |
| `extrude-eval.ts` | `evalExtrudeExpr(node, props, tileZoom?, feature?)`: thin wrapper over `@xgis/compiler` `evaluate()` + `makeEvalProps()`. Coerces result to a finite positive number or `null`; NaN, Infinity, zero, negative, non-number, and thrown evaluations all return `null`. Injects `$zoom` via `tileZoom` so `interpolate(zoom, …)` height expressions resolve to the correct stop. Also accepts an optional `feature` arg to inject `$geometryType` and `$featureId` — geometry-type-only or feature-id-only height expressions evaluate cleanly against an otherwise-empty props bag.                                          |

## For AI Agents

### Working In This Directory

- Both files run inside worker threads — they must remain WebGPU-free and must not import anything outside `@xgis/compiler` and local helpers. Pulling in GPU or DOM types will break the worker bundle.
- `computeSliceKey()` stability is a correctness invariant: two shows with structurally identical filter ASTs (even from different parse runs) must produce the same key. Changing the hash algorithm or key format breaks slice dedup and reintroduces overdraw across all tile pipelines.
- NaN and `null`/`undefined` property handling in `evalFilterExpr()` follows Mapbox filter semantics — the `v !== 0 && Number.isFinite(v)` guard for numeric results is load-bearing; pre-fix, NaN was accepted as truthy.
- `hashAstIterative()` uses a visited `WeakSet` to handle circular ASTs; property keys are sorted before walking to ensure insertion-order-independent hashes. Do not change sort order without updating the slice-key tests.
- Per-feature throw isolation (`try/catch → false/null`) is intentional: one pathological feature in a 10 000-feature tile must not abort the rest of the slice bake.

### Testing Requirements

Seven test files cover this directory (all `*.test.ts`, not listed in Key Files above):

- `filter-eval-fuzz.test.ts` — fuzz coverage over `evalFilterExpr` inputs
- `filter-eval-nan-coverage.test.ts` — NaN / non-finite / null property edge cases
- `feature-id-filter.test.ts` — `$featureId` reserved key in filter ASTs
- `geometry-type-filter.test.ts` — `$geometryType` reserved key routing
- `place-filter-routing.test.ts` — multi-layer filter routing scenarios
- `slice-key.test.ts` — `computeSliceKey()` stability and dedup invariants
- `extrude-eval.test.ts` — `evalExtrudeExpr()` coercion + zoom injection

Any new operator or reserved key must add: NaN/null edge cases to `filter-eval-nan-coverage.test.ts` and slice-key stability assertions to `slice-key.test.ts`.

### Common Patterns

- `null` return means "no usable value — caller uses its fallback". Never throw from public exports.
- Structural hashing via iterative djb2 (not `JSON.stringify`) for stability on large/circular ASTs.
- `makeEvalProps()` from `@xgis/compiler` is the canonical way to inject reserved keys (`$zoom`, `$geometryType`, `$featureId`) into the property bag before calling `evaluate()`.

## Dependencies

### Internal

- `@xgis/compiler` — `evaluate()`, `makeEvalProps()`, filter/extrude AST node types.

### External

- None.

<!-- MANUAL: notes below this line are preserved on regeneration -->

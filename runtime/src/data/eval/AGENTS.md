<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# eval

## Purpose
Expression evaluators that run at MVT decode time, inside the worker, before geometry is compiled. Their job is to pre-bucket a source layer's features so the renderer doesn't overdraw. Multiple xgis layers often share one MVT source layer with different filters (e.g. six `landuse_*` layers reading one `landuse` layer); evaluating filters here splits the source layer into per-filter sub-slices keyed by a stable hash, so shared filters dedupe and each draw paints only its matching features instead of the full layer. Also coerces per-feature extrude-height expressions and feature-id filters.

## Key Files
| File | Description |
|------|-------------|
| `filter-eval.ts` | Evaluates filter ASTs at decode time + `computeSliceKey()`. Splits a source layer into per-filter sub-slices; identical filters share a slice via stable hash. The fix for landuse/roads overdraw. |
| `extrude-eval.ts` | Thin wrapper over compiler `evaluate()` coercing the result to a finite positive number or `null` (NaN/Inf/0/negative/non-number → null → caller uses fallback height). |

## For AI Agents

### Working In This Directory
- These run in worker threads — keep WebGPU-free and import only `@xgis/compiler` `evaluate`/`makeEvalProps` (already in the worker bundle) plus local helpers.
- `computeSliceKey()` must be stable: two shows with structurally identical filters must produce the same key or the dedup breaks and overdraw returns.
- Filter NaN/null handling is load-bearing for correctness — comparisons against missing properties must follow Mapbox filter semantics.

### Testing Requirements
- Fuzzed + edge-cased: `filter-eval-fuzz.test.ts`, `filter-eval-nan-coverage.test.ts`, `feature-id-filter.test.ts`, `geometry-type-filter.test.ts`, `place-filter-routing.test.ts`, `slice-key.test.ts`, `extrude-eval.test.ts`. Add NaN/null + slice-key-stability coverage for new operators.

### Common Patterns
- `null` return = "no usable value, fall back". Stable structural hashing for slice dedup.

## Dependencies

### Internal
- `@xgis/compiler` (`evaluate`, `makeEvalProps`, filter AST types).

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

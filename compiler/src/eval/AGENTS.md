<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# eval

## Purpose
The expression evaluator: runs AST `Expr` trees against a feature-property bag and returns a value. It powers two distinct paths — compile-time constant folding (`ir/const-fold.ts` calls `evaluate()` with an empty props bag) and runtime data-driven styling (e.g. `size-[speed / 50 | clamp(4, 24)]` evaluated per feature). It implements the full builtin/operator set with Mapbox-compatible semantics (match, coalesce, type coercions, comparisons, math/string builtins) and defines the reserved property keys the runtime injects before each call.

## Key Files
| File | Description |
|------|-------------|
| `evaluator.ts` | `evaluate(expr, props)` + `FeatureProps` type. Walks the AST, handling field access, builtins, operators, match/case/coalesce, and the reserved keys (`$zoom`, `$featureId`, `$geometryType`). |
| `reserved-keys.ts` | THE source of truth for the reserved prop literal strings: `CAMERA_ZOOM_KEY` (`$zoom`), `FEATURE_ID_KEY`, `GEOMETRY_TYPE_KEY` + `makeEvalProps`, `normalizeGeometryType`. The evaluator looks these up by exact name. |

## For AI Agents

### Working In This Directory
- `reserved-keys.ts` is the single source of truth for `$zoom`/`$featureId`/`$geometryType`. Never re-type those literals elsewhere — import them. A typo silently breaks zoom/feature-driven styling.
- Evaluator semantics must match Mapbox/MapLibre (see `spec/oracle.ts` + `convert/`). When in doubt about an operator's behavior, the spec oracle and the Mapbox conformance tests are the contract.
- The same `evaluate()` is reused for compile-time folding (empty props) — keep it side-effect-free and deterministic.

### Testing Requirements
- Colocated: `evaluator-fuzz.test.ts`, `evaluator-builtins-fuzz.test.ts`, `evaluator-nan-bool-coverage.test.ts`, `reserved-keys.test.ts`. Plus `src/__tests__/evaluator.test.ts`, `evaluator-roundtrip.test.ts`, `match-evaluator-mapbox-shape.test.ts`, and many operator-coverage specs. Run the fuzz tests after any builtin/operator change.

### Common Patterns
- Mapbox-faithful coercion + null handling; NaN/boolean edge cases are explicitly tested. Builtins are dispatched by name.

## Dependencies

### Internal
- Imports `parser/ast`; consumed by `ir/const-fold`, `format/`, runtime workers.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# spec

## Purpose

Single source of truth for Mapbox/MapLibre style-spec semantics inside the compiler. `oracle.ts` wraps `@maplibre/maplibre-gl-style-spec` to answer "what does the spec say about property X?" — its default value, type, interpolation constraints, and expression evaluator — so `ir/lower.ts`, `convert/layers.ts`, and the runtime never hand-code magic defaults (`?? [0,0,0,1]`) again. `zero-semantics.ts` separately pins what `value=0` means per spec for each catalogued property, closing the class of drift bugs (pre-oracle: 11 silent-failure PRs #94–#105) where the runtime misapplied zero.

## Key Files

| File                | Description                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oracle.ts`         | Spec oracle: `specProperty` / `specDefault` / `specDefaultColorRgba` look up the raw `@maplibre/maplibre-gl-style-spec` `latest` block. `createSpecExpression` / `createExpression` re-export the MapLibre reference evaluator for differential conformance tests. `spec` re-exports the full spec object for exhaustive property walks. Compiler-only devDep — zero runtime bundle reach. |
| `zero-semantics.ts` | `ZERO_SEMANTICS` table (18 entries across fill/line/symbol/circle/fill-extrusion/raster) with `ZeroKind` tags (`identity`, `strict-zero`, `invisible-but-present`) and per-property rationale. `zeroSemantic()` lookup helper. Changing any entry is a spec-conformance decision requiring test update.                                                                                    |
| `oracle.test.ts`    | Vitest smoke tests pinning the oracle's public surface: raw spec version, property-def shape, `specDefault` scalars, `specDefaultColorRgba` color parsing (text-halo-color `rgba(0,0,0,0)` and text-color `#000000`), expression evaluator arithmetic, and unknown-property error path.                                                                                                    |

## For AI Agents

### Working In This Directory

- `oracle.ts` is the canonical defaults source for the entire compiler. When adding or fixing any property default in `lower`/`convert`/runtime, add it here first and consume via `specDefault`/`specDefaultColorRgba` — never re-hardcode `??` fallbacks at call sites.
- `zero-semantics.ts` encodes deliberate spec-compliance decisions. Modifying a `ZeroKind` or `rationale` is a spec-conformance change; justify against MapLibre behaviour and update the corresponding test.
- `@maplibre/maplibre-gl-style-spec` is a **compiler devDependency only** — nothing in this directory is imported by the runtime bundle. Keep it that way.
- No subdirectories exist under `spec/`; `oracle.test.ts` is colocated, not under `__tests__/`.

### Testing Requirements

- Colocated `oracle.test.ts` covers the oracle API surface.
- `src/__tests__/mapbox-spec-conformance.test.ts` (WS-3) holds the full differential / property-coverage suite that consumes this module — run it when touching either file.
- `src/__tests__/zero-semantics.test.ts` pins zero-behaviour contracts; run when changing `ZERO_SEMANTICS`.

### Common Patterns

- Plain lookup tables and thin wrappers over `@maplibre/maplibre-gl-style-spec`; no logic beyond colour-string parsing via `resolveColor` + `hexToRgba`.
- `createSpecExpression` is the golden evaluator for differential checks: run our `evaluate()` and the MapLibre reference side-by-side at the same `(zoom, feature)` points.

## Dependencies

### Internal

- `../tokens/colors` (`resolveColor`) and `../ir/render-node` (`hexToRgba`) for colour-default parsing.
- Consumed by `../ir/lower`, `../convert/layers`, `../eval/`.

### External

- `@maplibre/maplibre-gl-style-spec` (compiler devDependency; `latest` spec object + `createExpression`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

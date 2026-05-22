<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# spec

## Purpose
The Mapbox/MapLibre style-spec source of truth for the compiler. The oracle answers "what does the spec say about property X?" — its default value, type, range — so `ir/lower.ts`, `convert/layers.ts`, and the runtime stop hand-coding magic defaults (`?? [0,0,0,1]`) and instead get the canonical value MapLibre's own renderer would use. The zero-semantics module separately pins what `value = 0` MEANS per spec for properties where the runtime historically drifted (e.g. `line-blur=0` should NOT apply a 1.5px fade).

## Key Files
| File | Description |
|------|-------------|
| `oracle.ts` | The style-spec oracle — canonical per-property defaults/types/ranges that MapLibre would apply. Replaces scattered hand-coded fallbacks. |
| `zero-semantics.ts` | Per-property `value=0` semantics per spec vs. how the runtime treated them; documents and pins the correct zero behavior (line-blur, line-gap-width, line-offset, …). |

## For AI Agents

### Working In This Directory
- This is the canonical defaults source. When adding/fixing a property default anywhere in `lower`/`convert`/runtime, add it to `oracle.ts` and consult it — do not re-hardcode `??` fallbacks at call sites.
- `zero-semantics.ts` encodes deliberate spec-compliance decisions; changing a zero behavior is a spec-conformance change and must be justified against MapLibre, with the corresponding test updated.

### Testing Requirements
- Colocated `oracle.test.ts`; plus `src/__tests__/zero-semantics.test.ts` and the spec-conformance / spec-strict suites.

### Common Patterns
- Plain lookup tables keyed by property name; faithful to `@maplibre/maplibre-gl-style-spec`.

## Dependencies

### Internal
- Consumed by `ir/lower`, `convert/layers`, `eval/`.

### External
- Mirrors `@maplibre/maplibre-gl-style-spec` (dev-referenced in tests).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

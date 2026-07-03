---
name: data-gate-must-match-render-gate
description: A per-feature runtime resolver only works if the worker SHIPS the data — the needsFeatureProps data-gate must be as permissive as the render gate
triggers:
  - needsFeatureProps
  - featurePropKeys
  - show-source-maps
  - featureProps undefined
  - sizeExpr
  - buildFeatureProps
  - data-driven size/color not rendering
  - per-feature not applied at runtime
---

# Data-layer gate must match the render-layer gate

## The Insight

When a runtime renderer resolves per-feature data (evaluating an expression
against `tileData.featureProps`), TWO independent gates must agree:

1. **Render gate** — where the resolver decides to evaluate. e.g.
   `flushTilePoints` / VTR: `wantsFeatProps = show.sizeExpr?.ast != null`.
2. **Data gate** — where the MVT worker decides whether to BUILD + SHIP
   `featureProps` at all: `show-source-maps.ts` `needsFeatureProps`
   (~:231) → `mvt-worker.ts:384` `needsFeatureProps ? buildFeatureProps(...) :
empty` → `featureProps.size>0 ? … : undefined`.

If the data gate is STRICTER than the render gate, the worker ships NO
`featureProps` for that source, `tileData.featureProps` is `undefined`, and the
resolver silently falls back to the constant — the feature renders but does not
vary. Historically `needsFeatureProps` only covered `show.label` +
`shaderVariant.needsFeatureBuffer` (GPU feature-buffer paint), NOT CPU-resolved
point size/color — so a data-driven point size collapsed to `show.size ?? 6`.

## Why This Matters

A synthetic unit test that hand-builds `show.sizeExpr` + a `featureProps` map
passes (it bypasses the data gate entirely), while the REAL pipeline never ships
`featureProps` and the render is unchanged. This is the exact trap that let the
gap ship: the test proved the resolver, not the data delivery.

## Recognition Pattern

- "I wired the per-feature resolver + the unit test passes, but the real demo
  looks the same."
- Instrumenting the resolver shows the expression AST is present (`hasAst:true`)
  but `withProps:0` / `tileData.featureProps` is `undefined`.

## The Approach

Whenever you add a runtime consumer of `featureProps`, make the `show-source-maps`
`needsFeatureProps` predicate MIRROR the render-gate predicate EXACTLY, and add
the expression's referenced fields to `featurePropKeys` via `collectFieldsStrict`
(honor its null → full-props poisoning). Then VERIFY against the real pipeline
(deterministic real-render instrumentation: `withProps==N`, output actually
varies), never a synthetic-featProps unit test alone. A `buildShowSourceMaps`
test asserting `needsFeatureProps===true` + the field in `featurePropKeys` for a
REAL data-driven show is the fail-before gate.

## Example

```ts
// show-source-maps.ts — mirror the render gate:
const needsFeatureProps =
  show.label !== undefined ||
  show.shaderVariant?.needsFeatureBuffer === true ||
  show.sizeExpr?.ast != null // <-- the CPU-resolved point-size consumer
// + collectFieldsStrict(show.sizeExpr.ast) into featurePropKeys
```

See PR #731 (#722 S4), commit b8c9ec45.

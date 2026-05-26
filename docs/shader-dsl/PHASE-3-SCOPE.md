# Phase 3 — what's in / out of scope (AC7)

**Goal of Phase 3:** the compiler emits **zero** WGSL strings into the
polygon variant lane (`ShaderVariant.{fillExpr, strokeExpr, preamble,
fillPreamble, strokePreamble}`). The grep gate

```
grep -rE '/\*\s*wgsl\s*\*/' runtime/src/engine/
```

returns **0 hits** at PR-C close.

This doc enumerates exactly which compiler-internal WGSL paths
remain after Phase 2.5 lands — these are documented as out-of-scope
per the ralplan AC7. Phase 3's grep audit excludes the listed paths
by inclusion (only the AC1 variant-emit lane is gated).

## In scope (must reach 0 hits of `/* wgsl */` / hand-built WGSL strings)

The 11-file compiler/src/codegen/ surface that feeds the polygon
variant fields:

| File | Phase 2.5 task |
|---|---|
| `shader-gen.ts` | US-005 per-idiom Node conversion |
| `shader-gen-types.ts` | US-004 type migration (DONE for fillExpr / strokeExpr); preamble / fillPreamble / strokePreamble deferred to US-005/US-007 |
| `shader-gen-helpers.ts` | US-010 matchArmsKey rewrite (canonical-JSON over Node, helper landed at `_util/canonical-json.ts`) |
| `palette-emit.ts` | US-005 palette sample idiom |
| `categorical-encoder.ts` | US-005 match chain idiom |
| `wgsl-expr.ts` | US-005 generic Node builders |
| `paint-routing.ts` | US-005 dispatch update |
| `compute-variant.ts` | US-006 compute-variant retarget |
| `compute-variant-build.ts` | US-006 |
| `compute-variant-merge.ts` | US-004 wrap landed; US-006 unwraps via real Node construction |
| `compute-output-binding.ts:61` | US-006 binding emit |

After PR-B / PR-C close, every WGSL string assembled by these files
must have been replaced by a DSL Node value. The variant cache key
(`ShaderVariant.key`) survives the retarget via the canonical-JSON
serialisation of the matchExpr Node — see `_util/canonical-json.ts`.

## Out of scope (compiler-internal WGSL stays as-is)

These paths author WGSL strings INSIDE the compiler but DO NOT feed
the polygon variant fields — they are the compute-kernel lane,
debug helpers, and palette compute kernels:

### Compute kernels

- **`compute-gen.ts`** — `emitMatchComputeKernel`, `emitTernaryComputeKernel`,
  `emitInterpolateComputeKernel`. These build standalone
  `@compute @workgroup_size(N) fn main() { ... }` shader modules
  invoked via `dispatcher.dispatch()`. The output buffer is read
  back through `computeBindings` into the variant's `fillExpr` /
  `strokeExpr` (now Node-typed) via `unpack4x8unorm(out_fill[i])` —
  the COMPUTE KERNEL itself is a separate pipeline; its WGSL stays
  hand-built. The READ-BACK expression is the migration boundary,
  and it migrates in US-006.

### Palette / atlas compute helpers

- **`palette-emit.ts:emitPaletteBindings`** — the `@group(0)
  @binding(N) var color_grad_atlas: texture_2d<f32>;` declaration
  block + the `palette_color(i)` helper fn. These ARE prepended to
  `ShaderVariant.preamble`, so they ARE in the migration surface
  → US-005 idiom #5 (palette sample) + US-007's `Partial<ModuleDecl>`
  preamble shape consumes them. They're listed here for completeness
  but they belong to the in-scope set; the helper-fn shape is the
  natural DSL `FuncDecl` migration target.

### Debug overlays / playground scaffolding

- **`playground/src/...`** — the demo runner's debug overlays
  (graticule, picking overlay, overdraw visualisation) are runtime-
  side, NOT compiler-side. The runtime renderer can compose those
  via the DSL post-US-008 if needed, but they don't feed
  ShaderVariant. Out of scope for Phase 3.

### Runtime hand-WGSL shaders (already Phase 2 / Phase 0)

- **`runtime/src/engine/render/renderer-shaders.ts`** — the
  POLYGON_SHADER_SOURCE template that US-007's `polygon.ts` DSL
  composer REPLACES. US-008 deletes this file along with the
  `_back-compat/` adapter, so it's only present during the
  in-flight migration window. After US-008 lands, the polygon
  shader has no hand-WGSL counterpart.

## Audit rule

The Phase 3 grep is structurally scoped, not blanket:

```
grep -rE '/\*\s*wgsl\s*\*/' runtime/src/engine/
```

- Targets `runtime/src/engine/` only — compiler-internal `/* wgsl */`
  markers in `compute-gen.ts` etc. are out of this regex's reach.
- Excludes `__polygon-variant-snapshots__/` (committed `.wgsl`
  fixtures from US-000); `.wgsl` files are baseline data, not
  emit paths.
- A hit inside `runtime/src/engine/render/renderer-shaders.ts`
  is expected DURING the migration (file is alive until US-008
  deletes it) and the AC7 gate fires only AFTER US-008.

## Closure checklist

- [ ] US-005 + US-006 + US-007 + US-008 land — variant-emit lane
      Node-typed end-to-end; `renderer-shaders.ts` + `_back-compat/`
      adapter deleted.
- [ ] AC7 grep `grep -rE '/\*\s*wgsl\s*\*/' runtime/src/engine/`
      returns 0 hits.
- [ ] `matchArmsKey` rewired to hash `canonicalJsonStringify(node)`
      so the variant cache identity stays stable across engines.
- [ ] This doc is the authoritative scoping contract for any
      follow-up audit; update it if a new compiler-internal WGSL
      path is introduced.

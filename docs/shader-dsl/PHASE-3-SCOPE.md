# Phase 3 — what's in / out of scope (AC7)

**Goal of Phase 3:** the compiler emits **zero** WGSL strings into the
polygon variant lane (`ShaderVariant.{fillExpr, strokeExpr, preamble,
fillPreamble, strokePreamble}`). The canonical AC7 grep gate (PR-C
close) is the polygon-variant-lane-only variant — see the tightened
grep snippet under **Tightened AC7 grep for the PR-B/PR-C closeout**
below; it returns 0 hits.

The unfiltered form

```
grep -rE '/\*\s*wgsl\s*\*/' runtime/src/engine/
```

stays > 0 until Phase 4+ migrates the runtime non-polygon hand-WGSL
paths (renderer.ts overdraw/OIT compose, debug-flags overdraw,
frame-uniform, reprojector compute kernel). The unfiltered hits are
load-bearing documentation now, not a gate. See "Runtime hand-WGSL
outside the polygon variant lane" for the Phase 4+ migration scope.

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
  composer REPLACES. **DELETED at US-010 close.** US-008 retired the
  runtime consumers, US-009 retired the test consumers, US-010
  rewired the snapshot capture script to use the composer's emit
  via the shared `_polygon-fixtures.ts` module. The legacy template
  has no remaining consumers in the source tree.

### Runtime hand-WGSL outside the polygon variant lane

These runtime files carry inline `/* wgsl */` template strings but
do NOT feed `ShaderVariant.{fillExpr,strokeExpr,preamble,fillPreamble,
strokePreamble}` — they're independent shader entry points that the
polygon DSL composer never touches. Phase 4+ migration targets, NOT
in PR-B/PR-C scope:

- **`runtime/src/engine/render/renderer.ts:587`** — overdraw compose
  fragment shader (`?debug=overdraw` colormap pass). Single-purpose
  debug overlay; runtime composes it at pipeline-build time with no
  variant codegen.
- **`runtime/src/engine/render/renderer.ts:1125`** — OIT compose
  fragment shader (weighted-blended translucent resolve). Same shape
  as overdraw: one-shot pipeline, no variant fields.
- **`runtime/src/engine/debug-flags.ts:43`** — `OVERDRAW_FS_SOURCE`
  helper exported for the overdraw debug stage above. Tightly coupled
  to the runtime overdraw pipeline; migrates alongside renderer.ts:587
  when the overdraw stage moves to DSL.
- **`runtime/src/engine/gpu/frame-uniform.ts:42`** — `WGSL_FRAME_UNIFORM`
  shared uniform block (re-used at module-level by every shader that
  declares the camera/frame uniforms). Cross-cutting concern; DSL
  migration depends on a ConstDecl/BindingDecl module-level merge
  helper that doesn't exist yet.
- **`runtime/src/engine/projection/reprojector.ts:19`** —
  `REPROJECT_SHADER` compute kernel for input-tile reprojection (EPSG
  → WGS84). Compute-kernel lane parallels `compute-gen.ts` on the
  compiler side; same Phase 4+ migration boundary.
- **`runtime/src/engine/shaders/AGENTS.md`** — documentation, not
  emit. Two `/* wgsl */` references in prose describe the existing
  pattern; they don't author shader text.

### Tightened AC7 grep for the PR-B/PR-C closeout

The strict `runtime/src/engine/` grep currently surfaces all six of
the files above. The PR-B/PR-C scope is the **polygon variant lane
only**, so the closure-checklist grep accepts an inclusion-filtered
form that excludes the Phase 4+ runtime files:

```bash
grep -rE '/\*\s*wgsl\s*\*/' runtime/src/engine/ \
  --exclude='renderer-shaders.ts' \
  --exclude-dir=__polygon-variant-snapshots__ \
  --exclude=AGENTS.md \
  --exclude='renderer.ts' \
  --exclude='debug-flags.ts' \
  --exclude='frame-uniform.ts' \
  --exclude='reprojector.ts'
```

Returns **0 hits** once US-010 deletes `renderer-shaders.ts`. The
unfiltered grep stays >0 until Phase 4+ migrates the runtime non-
polygon hand-WGSL paths above.

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
  is expected DURING the migration (file is alive until US-010's
  AST-equivalence diff supersedes the snapshot capture script's
  baseline emit; deletion follows in the same PR).
- A hit inside the runtime non-polygon hand-WGSL files listed in
  the "Runtime hand-WGSL outside the polygon variant lane" section
  is **expected post-PR-C** — they migrate in Phase 4+, not Phase
  2.5. The tightened grep snippet above (line 130) is the actual
  closure-checklist gate; this strict form documents the unfiltered
  long-term target.

## Closure checklist

- [x] US-005 + US-006 + US-007 + US-008 + US-009 land — variant-emit
      lane Node-typed end-to-end via `polygon.ts` DSL composer + the
      `buildShader` / `pickShader` rewire. PR #152 (Phase 2.5 PR-B)
      merged 2026-05-26.
- [x] US-010 byte-equal drift gate lands at
      `polygon-variant-diff.test.ts` (8 fixtures × emit-vs-snapshot
      diff via shared `_polygon-fixtures.ts` module). Re-capture
      protocol: `bun scripts/capture-polygon-snapshots.ts` refreshes
      snapshots after intentional composer changes. Snapshot baseline
      now indexes the COMPOSER output, not the legacy template —
      pixel survey + CI render-gate validate LEGACY ≡ DSL semantic
      equivalence end-to-end at the rendered-pixel level. The AST-
      equivalent diff against the legacy POLYGON_SHADER_SOURCE was
      deferred (declaration order + paren density + swizzle
      conventions would need a ~300-LOC WGSL tokenizer normaliser);
      the byte-equal-vs-composer-baseline approach satisfies the
      per-commit drift detection goal of US-010 without the
      tokenizer dependency.
- [x] `runtime/src/engine/render/renderer-shaders.ts` DELETED (US-010
      close — no remaining source-tree consumers after the snapshot
      capture script switched to the composer's emit via
      `_polygon-fixtures.ts`).
- [ ] `_back-compat/node-to-wgsl-string.ts` adapter deletes after
      `NodeLike` + `wgslRaw` relocate to a stable compiler-side
      location (post-US-010) AND the renderer.ts splice-point lookup
      drops the `nodeToWgslString` call.
- [ ] AC7 grep (tightened form, line 130 above) returns 0 hits in the
      polygon-variant-lane after `renderer-shaders.ts` deletes. The
      unfiltered grep stays > 0 until Phase 4+ migrates the runtime
      non-polygon hand-WGSL paths (renderer.ts overdraw/OIT compose,
      debug-flags overdraw, frame-uniform, reprojector).
- [x] `matchArmsKey` rewired to hash `canonicalJsonStringify(node)`
      so the variant cache identity stays stable across engines.
      Landed in PR #151 (Phase 2.5 PR-A foundations) at
      `compiler/src/codegen/_util/canonical-json.ts`.
- [ ] This doc is the authoritative scoping contract for any
      follow-up audit; update it if a new compiler-internal WGSL
      path is introduced.

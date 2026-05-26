# Phase 2.5 — compiler codegen idiom inventory

**Purpose:** enumerate every WGSL-string emission site that feeds the
runtime's `ShaderVariant.{fillExpr, strokeExpr, preamble, fillPreamble,
strokePreamble}`, and classify each into one of 11 named idiom buckets
so US-005's per-idiom Node conversion is decomposable. If the "other"
bucket exceeds **8 distinct novel idioms**, the migration falls back to
Option B' (preamble stays compiler-emitted `Stmt[]` instead of full
Expr-tree retarget) per the ralplan rev-4.

**Source-of-truth files** (the AC1 11-file surface):
- `compiler/src/codegen/shader-gen.ts` — primary emit
- `compiler/src/codegen/shader-gen-types.ts` — interface (US-004)
- `compiler/src/codegen/shader-gen-helpers.ts` — preamble line builders
- `compiler/src/codegen/palette-emit.ts` — palette WGSL fn + binding
- `compiler/src/codegen/categorical-encoder.ts` — categorical match
- `compiler/src/codegen/wgsl-expr.ts` — generic WGSL expression builders
- `compiler/src/codegen/paint-routing.ts` — paint→variant routing
- `compiler/src/codegen/compute-variant.ts` — compute-variant emission
- `compiler/src/codegen/compute-variant-build.ts` — per-show merge
- `compiler/src/codegen/compute-variant-merge.ts` — compute merge
- `compiler/src/codegen/compute-output-binding.ts:61` — binding emit

**Out of scope (per AC7):** `compute-gen.ts:199` (kernel lane);
compiler-internal compute kernels, debug overlays, palette compute
helpers. These may keep authoring WGSL strings post-Phase-2.5 — they
don't feed the polygon variant lane.

## Idiom buckets (11 named + 1 catch-all) — migration status

Legend: ✓ = Node-emit landed; ◐ = surface-Node landed, deeper migration deferred to US-007 (preamble field shape); ☐ = wgslRaw fallback still active.

| # | Idiom | Status | Shape | Conversion target |
|---|---|---|---|---|
| 1 | scalar const | ◐ | `const X: f32 = V;` (preamble, string field) | `ConstDecl[]` (blocked on preamble field migration in US-007) |
| 2 | vec literal const | ◐ | `const C: vec4f = vec4f(r,g,b,a);` (preamble, string field) | FuncDecl wrapper (count = 2, FuncDecl path chosen) — blocked on preamble field migration |
| 3 | match chain | ◐ | `var _mcSS = ...; if (field_id == 0u) { _mcSS = ...; }` | Surface `_mcSS` varref Node-emit landed (commit a095f1b idiom #4); matchPreamble string field stays until US-007 swaps to matchExpr + Stmt.switch hoist |
| 4 | feat_data lookup | ✓ | `feat_data[input.feat_id * N + K]` | `featDataField(name, fieldMap)` Node — covered by simpleScalarNode (commits cf83417, 42035cd) |
| 5 | color palette sample | ✓ | `textureSampleLevel(color_grad_atlas, palette_samp, vec2(t, row), 0.0)` | `emitColorGradientSampleNode` (commit af67050) |
| 6 | scalar palette sample | ✓ | `xgis_scalar_sample(idx, zoom, zMin, zMax)` | `emitScalarGradientSampleNode` (commit 06508d4) |
| 7 | zoom-interp cond chain (no palette) | ✓ | falls back to `u.fill_color` / `u.stroke_color` | covered by idiom #2 varref-pair pattern (commit ac05668) |
| 8 | gradient + scale | ✓ | `mix(vec4f(low), vec4f(high), clamp((val-min)/(max-min), 0, 1))` | `mix4 + clampF32 + f32{Sub,Div}` composition via `simpleScalarNode` for val/min/max (commits c965e04, 4f1708a) |
| 9 | categorical | ✓ | `CAT_PALETTE[u32(field) % 20u]` | `arrayIndex(constRefVec4('CAT_PALETTE'), u32Mod(toU32(featDataField(field)), u32Lit(20)))` (commits 30a558a, bbd0620) |
| 10 | computeBindings extension | ◐ | `@group/@binding` preamble decls + `unpack4x8unorm(compute_out_X[fid])` | fillExpr / strokeExpr Node-emit via `emitComputeOutputReadExprNode` (commit 4361e6e); preamble decl string stays until US-007 preamble field migration |
| 11 | other | (varies) | DataExpr arithmetic + builtin calls | `simpleScalarNode` handles BinaryExpr +-*/ + 19 WGSL builtin fn calls (commits 42035cd, 25476a6) |

## Remaining unmigrated shapes (still wgslRaw fallback)

- Comparison / logical BinaryExpr (`==`, `<`, `&&`, etc.) — exprToWGSL wraps these in `select(0.0, 1.0, ...)`, the converter doesn't recognise.
- UnaryExpr (`-x`, `!x`) — converter rejects.
- PipeExpr / nested FnCalls beyond the recognised builtin set.
- Compound conditional `branches[] + fallback` — multi-arm select chain.
- `time-interpolated` ColorValue (CPU-resolved into uniform; falls back to varref idiom #2 path which already Node-emits).
- compute-variant.ts internal addendum still produces a string `fillExpr` field (unused by the US-006 merge Node path, kept for back-compat).
- preamble / fillPreamble / strokePreamble fields stay `string` on `ShaderVariant` — `Partial<ModuleDecl>` migration is part of US-007's polygon DSL composer port.

## Emit-site map (one row per `ShaderVariant` field assignment)

| File:Line | Field | Bucket | Notes |
|---|---|---|---|
| `shader-gen.ts:92-95` | `fillExpr` (default) | 1 (placeholder `u.fill_color`) | The `node.fill.kind === 'none'` path; US-002 surfaces this via `fillIsDefault: true`. |
| `shader-gen.ts:94` | `fillExpr` (real fill) | dispatch → `buildFillExpr(fillResult, opacityResult)` | Calls into `processColorValue` → multiple buckets per the ColorResult.expr shape (see `processColorValue` rows below). |
| `shader-gen.ts:95` | `strokeExpr` | dispatch → `buildStrokeExpr(strokeResult, opacityResult)` | Same dispatch shape as fill. |
| `shader-gen.ts:134` | `preamble` | dispatch | `preambleLines.join('\n')` — composition of every bucket-3/5/6/8/10 site that pushed lines. |
| `shader-gen.ts:137-138` | `fillPreamble`/`strokePreamble` | 3 | `matchPreamble` from `processColorValue` (match if-else chains). |
| `shader-gen.ts:162-163` | `const ${prefix}_COLOR: vec4f = vec4f(0,0,0,0);` (kind='none') | 2 | Vec literal const. Always present in stroke-only / fill-only flows. |
| `shader-gen.ts:182` | `uniformName = 'u.fill_color'` / `'u.stroke_color'` | (placeholder) | The default-uniform expr; US-002 sentinel. |
| `shader-gen-helpers.ts:22-31` | `matchArmsKey` | (hash util) | Not an emit site per se — hashes existing strings; in US-010 this will hash the canonical-sorted JSON serialisation of the matchExpr Node. |
| `palette-emit.ts:201` | `generatePaletteWGSL` | 8 + 10 | Emits a `palette_color(i) -> vec4<f32>` fn AND the `@binding(2)/(4)` declarations. Two sub-conversions. |
| `palette-emit.ts:emitPaletteBindings` | `@group/@binding` declarations | 10 | Binding-decl block prepended via `preambleLines.unshift`. |
| `palette-emit.ts:emitScalarSampleHelper` | scalar palette sample fn | 8 | One-shot helper fn for the scalar atlas. |
| `categorical-encoder.ts:emitCategoricalMatch` | `var _mcSS: vec4f = D; if (...) { _mcSS = C0; }` | 3 | Match chain producer. |
| `wgsl-expr.ts:*` | binop / member access / paren-balanced expr builders | (utility) | Building blocks of buckets 2, 4, 5, 6, 7. Per-helper conversion. |
| `paint-routing.ts:*` | dispatch between palette / uniform / inline | (utility) | No direct WGSL emit — routes ColorResult shape. |
| `compute-variant.ts:91` | `fillExpr` for compute-routed fill | 4 + 10 | `feat_data.at(...)` analogue for compute output buffer + a `@binding(N) var<storage, read> out_fill: array<...>;` declaration prepended. |
| `compute-variant.ts:105-106` | `preamble` extension for compute bindings | 10 | The compute output binding decls. |
| `compute-variant.ts:113-114` | `strokeExpr` for compute-routed stroke | 4 + 10 | Same shape as fill. |
| `compute-variant-build.ts:*` | dispatch | (utility) | Selects which addendums to apply. No new emit. |
| `compute-variant-merge.ts:99-110` | merged `fillExpr` / `strokeExpr` / `preamble` | dispatch + 10 | Inherits from compute-variant.ts; merge logic is the only new artefact. |
| `compute-output-binding.ts:61` | extra binding emit | 10 | One more `@binding` line appended to preamble. |

## "Other" bucket — currently EMPTY

After walking the 11-file surface, every emit site classifies into one
of the 10 named idioms. **The "other" bucket count is 0**, well under
the 8-idiom budget — **the migration proceeds with Option B (full
Expr-tree retarget); B' fallback is NOT triggered.**

## Migration completeness (commits 28+ on PR #151)

13 idioms landed Node-emit at fillExpr / strokeExpr surface (US-005 #1–#13 + US-006 surface):

- **fully Node-emitted**: constant fill/stroke (#1/#2), time-interpolated (#2 via varref pattern), zoom-interp w/o palette (#2), categorical (#3 + #5 legacy fallback), match() surface (#4), gradient (#6), scale (#7), color-palette textureSampleLevel (#10), scalar-palette xgis_scalar_sample (#12), simple data-driven opacity (#8), arithmetic via BinaryExpr (#9), builtin fn calls (#13), compute-variant unpack4x8unorm read (#11 / US-006).
- **surface-Node only**: match-chain (fillExpr varref Node, matchPreamble still string), categorical (fillExpr Node, preamble palette decl still string), computeBindings (fillExpr Node, binding decl still string in preamble).
- **wgslRaw fallback active**: comparison / logical BinaryExpr, UnaryExpr, PipeExpr, non-recognised FnCall identifiers, conditional branches[].

The remaining items (preamble / fillPreamble / strokePreamble field migration + the polygon DSL composer's emitPolygonWgsl entry point) constitute **US-007 / US-008 / US-009 / US-010 / US-011** scope and are tracked in `[[project-shader-dsl-phase2-5-pr-a-2026-05-26]]`.

## Vec-literal const count

A direct grep of `const \w+: vec4f = vec4f\(` across the 11-file surface
produces exactly **2 distinct call sites** (the
`processColorValue:'none'` path emitting `${prefix}_COLOR: vec4f =
vec4f(0,0,0,0)` for fill and stroke). With count ≤ 3, the US-005 path
takes the **FuncDecl wrapper** route (zero IR change) rather than
extending `ConstDecl.wgslValue` to `number | Expr`. Decision finalised
here for US-005 to consume.

## Migration order (frequency-driven, US-005)

1. **scalar const** (bucket 1) — simplest, ConstDecl[] migration. Lands first as a confidence builder.
2. **vec literal const** (bucket 2) — 2 instances, FuncDecl wrapper path per the decision above.
3. **match chain** (bucket 3) — the workhorse. Uses matchExpr (US-001).
4. **feat_data lookup** (bucket 4) — `feat_data.at(index, f32T)`.
5. **palette sample** (bucket 5) — `textureSample` on palette binding.
6. **zoom-interp / time-interp cond chains** (buckets 6, 7) — nested `select()` (no matchExpr — these aren't categorical).
7. **gradient helper fn** (bucket 8) — DSL `FuncDecl` + `callFn`.
8. **computeBindings extension** (bucket 10) — appended `BindingDecl[]`.

Each conversion lands in its own commit per US-005 so failures revert atomically.

## Re-verification

`PHASE-2-5-IDIOM-INVENTORY.md` is the authoritative map; the AC1 grep
gate verifies the actual code matches:

```
grep -rE '/\*\s*wgsl\s*\*/|\bvec4f\(|\bf32\b\s*=' compiler/src/codegen/{shader-gen,shader-gen-helpers,palette-emit,categorical-encoder,wgsl-expr,paint-routing,compute-variant,compute-variant-build,compute-variant-merge,compute-output-binding}.ts
```

Expected: **0 hits** once US-005 + US-006 land. Re-run this file's
audit if the codegen surface changes during the migration.

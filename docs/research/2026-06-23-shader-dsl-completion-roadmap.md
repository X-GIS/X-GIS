# @xgis/shader-dsl — completion roadmap (standalone DSL)

**Date:** 2026-06-23 · **Status:** Phase 0 in progress
**Backbone:** reflection-first (judge-panel of 4 framings → architect synthesis; all claims verified file:line).

## Why "it feels lacking" — two independent root causes

1. **Value gap** — the IR holds every binding/struct/entry fact (`BindingDecl` nodes.ts:94, `StructField` :84, `FuncDecl` :104) but `emitModule` (emit.ts:128) discards it into a **string**. So the DSL emits a _shader_, not a _pipeline_; the host re-derives bind-group layout + uniform byte offsets BY HAND. Verified: `runtime/.../point-uniform-layout.test.ts:19-46` literally reimplements a WGSL offset engine inline + regex-scrapes the CPU packer (and documents a real `viewport @20 vs @24` drift bug). This is the slot-drift family `sot.ts` was built to kill — but SoT only unified _authoring_, not _host packing_.
2. **Credibility gap** — not wired as a consumable artifact: `package.json private:true`, `main`/`exports` → `./src/*.ts`, **stale/poisoned `dist/`** (still ships removed `shaders/` + `core/schema` — verified), no README, no LICENSE file, no `examples/`. Independent of (1).

## Capability standing (what a shader DSL should do)

STRONG: Author · Type-check · Optimize · Validate(20-rule lint+capGate) · **CPU-oracle parity (distinctive)** · Compose.
PARTIAL: Resource/IO (WGSL-coupled at `attr` strings only — IR types are STRUCTURED, types.ts:11-19; `typeKey` is a derived compare string, NOT deep coupling) · Multi-target (WGSL real, GLSL stub).
MISSING: **#6 Reflect** (pipeline metadata) · **#10 Host integration**.

## Roadmap (sequenced)

| Phase          | Goal                                                                                                                                                                                                                                                                                                                   | Effort/Risk                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **0 ⭐ FIRST** | `core/reflect.ts` — neutral `Reflection` type + pure `wgslLayout(std140/std430)` offset engine + `reflect(ModuleDecl)` walker. **Additive, never on emit path = byte-safe.** Anchored to shipping offsets (point Uniforms: mvp@0/proj_params@64/viewport@80/cam_ecef_h@96/cam_ecef_l@112/circle_params@128, size 144). | S/M · LOW                                                                      |
| 1              | `emitModuleWithReflection(m):{code,reflection}` from the SAME lowered module; `emitModule` stays byte-identical. Export from barrel.                                                                                                                                                                                   | S · LOW                                                                        |
| 2 ∥            | standalone-product: package.json→`dist` wiring + **clean-rebuild poisoned dist** + README(shows reflection) + `examples/`(tsx-runnable) + LICENSE + fix AUTHORING.md:12. Keep `private:true` (no publish).                                                                                                             | M · LOW                                                                        |
| 3 🚦           | go/no-go: retire ONE hand-wired packing site (point uniform) via reflection + runtime `reflectionToWebGPU` adapter. descriptor+buffer byte-identical.                                                                                                                                                                  | L · HIGH (render-gate e2e + real-GPU smoke; oracle is f32-blind, oracle.ts:16) |
| 4              | GLSL std140 UBO + entry-IO, reflection-fed (glsl.ts:83 "later step" = this engine). headless-WebGL2 compile gate.                                                                                                                                                                                                      | XL · MED (last)                                                                |

## Explicitly NOT doing

1. **No IR `attr`-lexeme restructure now** — not on the critical path (reflect reads structured SoT inputs, quarantines the one lexeme parse); touching IR risks the byte-gate for zero near-term value. Future open question, not a phase.
2. **No SPIR-V / MSL / HLSL** — mono-target-but-credible is fine for v1.
3. **Phase 3 not before 0-1 green; never verify it with the CPU oracle** (f32-blind ⟹ a CPU pass is NOT GPU-parity evidence).

## Corrections applied (verified, vs earlier overstatements)

- IR types are structured; `'vec3<f32>'` is only `typeKey` (types.ts:55) — the "typeKey deep coupling" claim was overstated.
- `tsc --build` already emits `.d.ts` (`tsconfig.base.json declaration:true`) — packaging gap is wiring, not emit.
- `dist/` is stale/poisoned (ships removed `shaders/`+`schema`) — Phase 2 needs a clean rebuild.

# Audit ⑦ — Compositing / transparency / blending (OIT)

_Deep-research synthesis, 2026-06-08. File:line audit of the X-GIS compositing pipeline merged with OIT (McGuire-Bavoil) and alpha-compositing research. Part of the 10-audit series. Claims cited inline._

---

## TL;DR

The compositing **architecture** is sound — a five-bucket pipeline (background → opaque → OIT → translucent → points) with correct opaque-before-translucent ordering, depth persistence across buckets, and single-resolve MSAA ownership. And the OIT **math** is a faithful McGuire-Bavoil weighted-blended implementation (two targets, correct weight Eq. 9, correct resolve). **But the headline finding recontextualizes Audit ③'s "OIT untested":** OIT is **hardcoded OFF** (`isOitExtrude = false`, `bucket-scheduler.ts:284`) and **architecturally incomplete** — the routing from a classified show to the OIT pipeline (`ClassifiedShow → VTR.render` pipeline selection) **does not exist**, so even if the flag were flipped, extrusions would draw through the standard opaque pipeline. It is **dead code with zero test coverage**. Consequence: **translucent extrusions today composite via order-dependent alpha blending** (painter's order) — the exact correctness problem OIT exists to solve is currently _unsolved_. Two secondary risks: three premultiplication conventions in one shader file with no compile-time check (silent-darkening trap), and OIT's weighted average running in sRGB (gamma) space.

---

## A. Architecture (as audited)

Five buckets: background (`background-pass.ts`) → **opaque** (`opaque-pass.ts`, depth test+write, ground layers depth-disabled) → **OIT** (`oit-pass.ts`, dual MRT accum rgba16f + revealage r16f) → **translucent strokes** (`translucent-pass.ts`, offscreen + composite) → **points**. Depth is cleared/stored by opaque and loaded (test-only, no write) by OIT/points — the correct hierarchy [McGuire-Bavoil: opaque first with depth-write, translucent depth-test-on/write-off, high]. MSAA: last bucket claims the `resolveTarget`; OIT compose averages samples in-shader. The blend-state constants (`BLEND_ALPHA`, `BLEND_ALPHA_PREMULT`, `BLEND_OIT_ACCUM`, `BLEND_OIT_REVEALAGE`) are clearly defined.

## B. Findings (file:line, severity)

### B1 — OIT is hardcoded off and architecturally incomplete — HIGH (dead code; the real translucency gap)

`bucket-scheduler.ts:284` `const isOitExtrude = false` (iter-193 reverted iter-192's two-pass OIT over bind-group plumbing). The OIT pipeline is _created_ (`renderer.ts:971-1008`) and the pass exists, but it is **never routed**: `ClassifiedShow` carries no OIT pipeline, so `VTR.render()` would draw extrusions with the standard opaque `fillPipeline` even from the OIT pass [audit #5,#8]. Tests return empty OIT buckets (`bucket-scheduler.test.ts`), so there's **zero coverage** [audit #5].
**What this means in practice:** translucent extrusions currently fall through to **order-dependent alpha blending** (`BLEND_ALPHA_PREMULT`, painter's order). The "over" operator is **non-commutative**, so overlapping translucent buildings composite _incorrectly_ depending on draw order — which is precisely what weighted-blended OIT (commutative sum + product, order-independent) was designed to fix [Wikipedia alpha-compositing; McGuire-Bavoil, high]. **Decision needed:** either _complete + test_ the plumbing (route `ClassifiedShow→fillPipelineExtrudedOIT`, flip the flag, add 3-overlap tests) or **delete the dead OIT code** — shipping it half-wired is a maintenance hazard and misleads (Audit ③ assumed it was merely untested).

### B2 — Three premultiplication conventions, no compile-time check — MEDIUM (silent-darkening trap)

`polygon.ts` emits **three** different fragment conventions: `fs_fill` non-premultiplied → `BLEND_ALPHA` (:609); `fs_fill_extrude` premultiplied → `BLEND_ALPHA_PREMULT` (:815); `fs_oit_translucent` pre-weighted → `BLEND_OIT_ACCUM`. All three are **currently correct**, but the pairing is an **implicit contract with no validation** [audit #6]. A future variant that emits non-premultiplied RGB while keeping `BLEND_ALPHA_PREMULT` silently darkens by 25-50% — the _exact_ bug already caught once at `line-renderer.ts:309-311`. The research is blunt: premultiplied makes "over" associative/filter-safe, and feeding a non-premultiplied value into a premultiplied path is "an ILLEGAL COLOR" that corrupts output [iquilezles; webgpufundamentals, high]. **Fix:** tag each `fs_*` with an output-type and each `BLEND_*` with its expected type; assert the pairing at pipeline creation (same shape as the layout-consistency test in the shader audit).

### B3 — OIT weighted average runs in sRGB (gamma) space — LOW (deliberate, but skews the average)

The canvas is non-sRGB unorm and shaders emit sRGB-encoded color (the deliberate MapLibre-matching choice, `gpu.ts:185`). But McGuire-Bavoil's accumulation is specified on **linear** color — `accum = color.rgb * color.a * weight` with `color` _linear_ [LearnOpenGL/McGuire, high] — so blending the OIT weighted average in sRGB **skews it** (the weighted mean of gamma-encoded values ≠ the gamma-encoding of the linear weighted mean). It's consistent with X-GIS's overall sRGB-blend decision (Audit #3 gamma) and invisible at typical alphas, but if OIT is ever enabled this is a real (if minor) correctness caveat to document. [audit #7]

### B4 — fp16 accumulation bounds at 3+ low-alpha layers — LOW (if OIT enabled)

The McGuire weight is tuned for **1–100 surfaces with alpha in [0.2, 0.9]** using fp16 blending; outside that range it must be re-tuned, and unclamped weights can **overflow fp16 (→Inf, poisoning the pixel)** while darker-than-source regions signal underflow [McGuire blog, high]. X-GIS clamps the depth term to `[1e-2, 3e3]` (`polygon.ts:798`), which keeps a per-fragment floor and mitigates this — but the `accum.rgb / max(accum.a, 1e-5)` resolve has no documented lower bound on `accum.a` for stacks of many low-alpha fragments [audit #2]. Add a 3+-overlap test if OIT is enabled.

### B5 — OIT MSAA depth sub-sample mismatch — MEDIUM (if OIT enabled)

OIT accum/revealage are MSAA (sampleCount `sc`) and test against the opaque MSAA depth per sub-sample; at a translucent-opaque silhouette, sub-samples can split (some pass, some fail) → inconsistent coverage → **shimmering at edges during camera motion** [audit #1,#3]. Document or resolve opaque depth to single-sample before OIT; add an edge stress test. Standard MSAA also doesn't antialias blended transparency anyway (alpha-to-coverage is the bridge) [Golus, med].

## C. What's robust

Opaque-before-translucent bucket ordering with preserved declaration order (correct painter's order for opaque); depth cleared/stored by opaque, loaded by OIT/points, last bucket owns store (correct occlusion); MSAA resolve claimed exactly once by the last bucket; per-tile stencil clip-mask prevents parent/child z-fight; ground layers use depth-disabled painter's order (roads don't z-fight landuse); blend constants are named with documented semantics; the OIT compose correctly averages MSAA samples and uses an oversized fullscreen triangle. The _building blocks_ are right — the gap is the unwired OIT routing and the unchecked premultiplication contract.

## D. Top fixes (ranked)

1. **Resolve OIT's status** (B1) — decide: complete+test the routing (and fix B3/B4/B5 as part of enabling), or delete the dead code. Today's translucent extrusions are order-dependent; that's the real user-facing gap. Pairs with Audit ③'s OIT cell and Audit #4b's depth-ordering oracle.
2. **Premultiplication-convention compile check** (B2) — cheap; prevents the silent-darkening regression class that already bit once.
3. **If enabling OIT:** linear-space weighted average (B3), documented MSAA depth handling (B5), and 3+-overlap + low-alpha tests (B4).

---

## Sources

**Codebase audit (file:line):** `bucket-scheduler.ts:284,316-352` (isOitExtrude=false, routing), `passes/{opaque-pass.ts:57, oit-pass.ts:32-74, translucent-pass.ts, points-pass.ts}`, `renderer.ts:959-1050` (OIT pipeline/bind layout), `shaders/{polygon.ts:609,776-808,815, oit-compose.ts:35-109}`, `gpu-shared.ts:8-54,110-224` (blend/stencil constants), `gpu.ts:185-195` (sRGB/premult), `render-targets.ts:111-130`, tests `bucket-scheduler.test.ts`, `oit-compose-dsl.test.ts`.
**OIT research:** McGuire & Bavoil, "Weighted Blended OIT," JCGT 2013 http://jcgt.org/published/0002/02/09/ [high]; McGuire casual-effects blog (Eq. 9, blend states, fp16 over/underflow, 1-100 surfaces / alpha[0.2,0.9] tuning) http://casual-effects.blogspot.com/2014/03/weighted-blended-order-independent.html [high]; LearnOpenGL Weighted-Blended (two targets, linear-space requirement, opaque-first depth-write) [high]; MJP weighted-blended-oit (approximation, weight sensitivity) [med].
**Alpha compositing:** Wikipedia alpha-compositing (Porter-Duff "over" non-commutative, premultiplied factors) [high]; iquilezles premultiplied-alpha (associativity/filter-safety) [high]; realtimerendering "GPUs prefer premultiplication" (Forsyth) [high]; webgpufundamentals transparency (mixing conventions = illegal color, canvas alphaMode) [high]; NVIDIA GPU Gems 3 Ch.24 (linear-space blending) [high]; Golus alpha-to-coverage (MSAA+transparency) [med].

_Confidence: the codebase audit (direct read) and McGuire-Bavoil/alpha-compositing primary sources are load-bearing. The "OIT is dead code, translucency is order-dependent today" conclusion is the highest-value finding and is directly evidenced by `bucket-scheduler.ts:284` + the missing routing._

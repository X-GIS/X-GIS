# Audit ③ — Test strategy & coverage gaps

_Deep-research synthesis, 2026-06-08. Full file:line inventory of the X-GIS test landscape merged with GPU/rendering test-strategy research (Chromium, WebGPU CTS, MapLibre, the test pyramid). Part of the 10-audit series. Claims cited inline._

---

## TL;DR

X-GIS's test strategy is **architecturally sound and matches industry best practice** — it pushes verification _down_ to deterministic CPU/compute oracles (math parity, WGSL compile, layout consistency) that run in CI under SwiftShader, and reserves the real-GPU matrix gate as a deliberate local/pre-push last resort. That is exactly the layering Chromium prescribes (JS test > reference > pixel > text; "only write a pixel test if you cannot use a reference test") and the CTS's "read back a buffer and compare to a CPU oracle" pattern. The gap is **not the strategy — it's a specific, enumerable set of holes the strategy can't reach because SwiftShader can't rasterize them**: above all **OIT blend algebra and 3D-extrude depth ordering have _zero_ correctness coverage** (no oracle, no CI, real-GPU matrix cells absent), and several known bugs are tracked as `expected_red` that **flip green silently with no alert** if fixed or regressed past threshold.

---

## A. The test landscape (as audited)

- **Unit (vitest), CI-blocking, no GPU:** 258 runtime tests (+ compiler/blueprint) — projection math, layout consistency, filter/eval, text/collision, cache logic, arena. Deep coverage of non-GPU subsystems.
- **Render gates, CI-blocking, SwiftShader:** 4 specs — `_shader-math-parity` (WGSL `project()` vs CPU), `_wgsl-compile-gate` (enumerate polygon/line/point/raster/icon/text/OIT WGSL → `createShaderModule` on the software device, **compile errors only**), `_vs-clip-parity`, `_dequant-parity`. These are the CTS "operation test = readback vs CPU oracle" pattern [gpuweb CTS], runnable on software GPU because they're **pure compute, not rasterization**.
- **Matrix gate, real-GPU, local/pre-push only:** 6 seed cells; oracles regenerate from d3/closed-form (non-stale). **Not in CI** — "SwiftShader cannot raster the pipeline" (the boundary this whole series keeps hitting).
- **E2E / pixel-match / perf / picking, local only:** ~200 specs, mostly non-blocking.

This mirrors Chromium's structure exactly: a cheap **software pool** (SwANGLE/SwiftShader) that exercises shared code paths, plus a scarcer **physical-GPU tier** for what only hardware can show [Chromium swiftshader/pixel_wrangling docs]. The "real-GPU = local/pre-push" framing is a reasonable generalization of that split (Chromium separates the pools but doesn't name a "pre-push only" policy).

## B. What is therefore UNTESTED in CI (the SwiftShader shadow)

3D extrude depth rasterization · OIT accumulation + compose · overdraw compositing · non-Mercator visual output at deep zoom (globe/equirect/NE/azimuthal) · high-pitch tilt/sky-fill · antimeridian seam continuity · all pixel-level visual regression (baselines start `candidate` → soft). None of these can be validated by the software pool; they live only in the real-GPU matrix, which is local-only.

## C. Oracle coverage — what NO oracle catches

The matrix oracles (`numeric_forward`, `pixel_ref`, `ink_family`, `disc_fraction`, `black_ratio`, `finite_mvp`, `label_onscreen`, `frame_stability`, `post_change`, `screenshot_diff`) are strong for **projection math, geometry presence, determinism, and invalidation**. But **no oracle of any kind** covers: OIT blend algebra (accum weight / reveal-age), extrude depth-sort vs translucent fills, device-loss recovery, GPU resource leaks, worker cancellation semantics, label fade-animation timing, picking accuracy at DPR≠1, viewport-resize buffer lifecycle. These are correctness voids, not soft gates.

## D. Numbered gaps (severity) — 27 found; the load-bearing ones

1. **OIT weighted-blend algebra — CRITICAL.** `oit-compose-dsl.test.ts` checks emit _shape_ only; zero runtime/pixel verification of accumulation weights or reveal-age. OIT is the **only** path for translucent extrusions, so a silent accumulation bug ships. → a real-GPU cell rendering a known translucent stack vs a brute-force back-to-front sort.
2. **3D extrude depth ordering — HIGH.** `_building-depth-snapshot` traces render _order_ + a determinism hash, but nothing asserts opaque extrudes occlude/precede translucent fills, or probes z-fighting. (This is the same hole as Audit #4b's depth-ordering oracle — they should be built together.)
3. **Polygon _variant_ shader compilation — HIGH (corrects an earlier finding).** Contrary to the shader-pipeline doc's "no compile gate," `_wgsl-compile-gate.spec.ts` **does** compile most variants under SwiftShader in CI — but polygon **variant match-chain fixtures** (the regex-spliced preambles) are _not_ compiled standalone, so a variant that emits invalid WGSL fails only on first user-load. → extend the existing gate to `FIXTURES.filter(f => f.variant)`. Cheap, SwiftShader-safe, high payoff.
4. **GPU resource leak detection — MEDIUM.** No memory-growth test over many tile load/evict cycles, no `map.destroy()` resource audit. (Pairs with Audit ②'s glyph-atlas-page leak.)
5. **Label fade animation + S16 skip edges — MEDIUM.** Fade lifecycle untested; only one hard S16 cell — no "sig changes by 1 LSB → must rebuild" / "sig unchanged → byte-identical replay" / "stale-skip" probes.

Plus device-loss recovery (no test of the `gpu.ts` `deviceLost`/`contextlost` path), worker cancellation semantics (abort propagates, not just ignore-on-resolve), pick accuracy at DPR=2, uniform _value_ propagation (layout is tested, values aren't → wrong color renders silently), and missing matrix cells for stereographic/azimuthal-equidistant, polar regions, antimeridian closure, and a passing deep-zoom precision floor.

## E. Baseline management — good, with one alarm

The accept workflow is **human-triaged and refuses silent overwrite** (`bun run matrix:accept <id>`, `--force` required; `candidate → review → green`). This is precisely the guard the research demands: Chromium's Skia Gold triages new images before they become baselines [Chromium Gold], and MapLibre's `UPDATE=1` ships with the explicit warning that the generating implementation "is **not** always correct… manually inspect expected.png" [MapLibre render-tests]. X-GIS's `effectiveGate()` coercing `candidate`/`expected_red` to soft is a sound anti-blessing guarantee.

**The alarm:** an `expected_red` cell that gets fixed (or regresses past threshold) **flips with no alert** — the manifest documents 7 known bugs this way (azi/stereo cap, equirect/NE deep-zoom f32 drift, antimeridian seams, oblique polar tearing). A baseline "taken when something was already broken" is the canonical visual-regression failure mode ["every new test compares against a broken truth"]. **Fix (one line):** `if (cell.knownStatus === 'expected_red' && pass) log('EXPECTED_RED FIXED: ' + cell.id)` so a silent fix/regression is surfaced.

## F. What the strategy does well

Non-stale math oracles (regenerated every run → no baseline-blessing risk for geometry) · CI-blocking pure-compute gates that catch a real class of shader errors on the software pool · `frame_stability`+`post_change` proving determinism _and_ invalidation responsiveness · the manifest as a declarative, version-controlled coverage truth-table · anti-blessing guarantees (`--force`, `effectiveGate`). The strategy correctly embodies the pyramid's core lesson — every authoritative source pushes verification toward fast deterministic tests, and even Chromium (whose product _is_ graphics) treats GPU-dependent pixel tests as the costly last resort, not the foundation [Fowler; Google; Chromium].

## G. Top-5 gaps to close (ranked)

1. **OIT correctness** (D1, D-OIT-cells) — critical; the only translucent-extrude path is unverified.
2. **Extrude depth ordering** (D2) — build _with_ Audit #4b's oracle and the reversed-Z fix #4.
3. **Polygon variant compile gate** (D3) — ~20 lines, SwiftShader-safe, closes a silent user-load failure.
4. **`expected_red` flip alert** (E) — one line; stops silent fix/regression of 7 tracked bugs.
5. **GPU leak + map.destroy() audit** (D4) — pairs with Audit ②'s atlas-page leak.

Note the asymmetry the research stresses: items 3 and 4 are deterministic, GPU-free, near-zero-cost, and high-signal — exactly where the pyramid says to invest first; items 1, 2, 5 require the scarce real-GPU tier and should be batched into one matrix-expansion pass.

---

## Sources

**Codebase audit (file:line):** `runtime/src/**/*.test.ts` (258 unit), `playground/e2e/_wgsl-compile-gate.spec.ts`, `_shader-math-parity/_vs-clip-parity/_dequant-parity.spec.ts` (CI compute gates), `playground/render-verify/matrix.manifest.ts` + `matrix-oracles.ts` + `matrix-types.ts:131-136` (`effectiveGate`), `playground/render-verify/baselines/` + `matrix:accept`, `playground/playwright.config.ts:47-51` (tolerance), `oit-compose-dsl.test.ts`, `_building-depth-snapshot.spec.ts`, `gpu.ts` (deviceLost).
**Research:** Fowler practical-test-pyramid (pyramid, ice-cream-cone) https://martinfowler.com/articles/practical-test-pyramid.html [high]; Google "just say no to more e2e" (70/20/10, slow signal) [high]; mutation testing / coverage≠behavior (pedrorijo) [high]; characterization/golden-master (Feathers/Wikipedia) [high]; Chromium writing_web_tests (JS>reference>pixel>text ranking) https://chromium.googlesource.com/chromium/src/+/HEAD/docs/testing/writing_web_tests.md [high]; Chromium swiftshader + pixel_wrangling (software vs physical-GPU pools) [high]; Chromium Gold (Skia Gold triage, Sobel fuzzy, multiple approved images) [high]; WebGPU CTS intro/tests (operation = buffer-readback oracle; validation vs operation; per-case suppression) https://gpuweb.github.io/cts/docs/intro/ [high]; MapLibre render-tests + integration README (UPDATE warning, multiple expected, ignore lists) [high]; visual-regression stale-baseline failure mode (dev.to/oneuptime) [med].

_Confidence: the codebase inventory (direct read) and Chromium/CTS/MapLibre/Fowler primary docs are load-bearing. The "real-GPU = pre-push only" framing and the stale-baseline magnitude claims are flagged med (generalization / practitioner-sourced)._

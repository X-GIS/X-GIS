---
name: render-error-budget
description: >
  Catch render/coordinate bugs BEFORE rendering — by construction, not observation.
  Use this the moment a bug smells like PRECISION (deep-zoom drift, f32 loss, fill
  displaced from outline, "tolerance feels excessive", position wrong only past some
  zoom) or FRAME-CONSISTENCY (fill≠outline, CPU≠GPU divergence, sphere-vs-ellipsoid
  geoid, two paths disagree about where a point goes). These are MATH/FRAME bugs
  wearing a pixel costume; they are exhaustively catchable with a closed-form error
  budget, a single-authority/branded type, or a metamorphic invariant — no GPU, no
  screenshot, over the WHOLE input domain, not a sample. This is the FIRST resort.
  visual-artifact-bisect (render-and-eyeball) is the LAST resort, reserved for the
  genuinely emergent-raster residue (MSAA seams, blend, overdraw, sub-pixel coverage).
  If you are about to "render it and see", stop and check whether the bug is actually
  analytic first. X-GIS coordinate pipeline.
---

# Render error budget — catch it before you render

## Why this skill exists

The recurring failure mode in this codebase: a user reports a visible render bug,
someone fixes it by **render → eyeball → tweak → re-render**, the screenshot looks
right *at the tested camera*, it ships "done", and it **recurs** at a slightly
different camera/zoom — "잡을듯 말듯 몇십번" (almost-fixed, dozens of times).
`#387 → #389 → #392` (fill displaced from outline) is the canonical case: three
"fixes", two of them the **wrong root** (ring-coincidence, fill-translate), because
nobody had the analytic model that localizes the real root in one shot.

That loop is the signature of **verification by observation** on a partial oracle.
Observation samples a continuous, high-dimensional output space (camera × zoom ×
projection × data × surface); it finds bugs, it can never prove their absence
between samples, and the symptom-fix at the sampled point leaves the root to
re-surface elsewhere. The "dozens of attempts" is the *cost* of not having the
analytic gate.

**The fix is not a better screenshot. It is to stop observing and start proving.**
Most "graphics artifacts" are not emergent raster phenomena — they are coordinate
math or frame-of-reference bugs that have a **closed form**. You can bound them, or
make them unrepresentable, over the entire domain, on the CPU, in CI, before a
single pixel exists.

## Decision tree — pick the construction, not the camera

| Bug smell | Class | Technique (this skill) | Observation needed? |
|---|---|---|---|
| deep-zoom drift, f32 loss, fill/outline split, "excess tolerance", position wrong past zoom N | **precision** | **closed-form error budget** (§1) | No — exhaustive bound |
| fill≠outline, CPU≠GPU, geoid sphere-vs-ellipsoid, two paths disagree | **frame-consistency** | **single authority / branded type** — make the bad state unrepresentable (§2) | No — compile error |
| no closed form, no oracle, but a known relation (rotate/translate/zoom invariance, fill⊆stroke-bbox, seam continuity) | **geometric** | **metamorphic invariant** (§3) | No — oracle-free property |
| MSAA seam pixels, blend, depth/overdraw order, sub-pixel coverage | **emergent raster** | none of the above — this is the irreducible residue | **Yes** → `visual-artifact-bisect` |

The first three classes are ~75% of the recurring render bugs here. Only the last
genuinely needs eyes. Default to a construction; reach for the camera only when the
bug is provably emergent-raster.

## §1 Error budget (the spearhead — precision class)

A coordinate path is a sequence of f32 operations on an input over an operating
domain (zoom × lon/lat range). Its worst-case error has a **closed form**; you do
not need to render to know it.

Procedure:

1. **Identify the dominant error term.** For an f32 value of magnitude `M`, a single
   rounding is at most a half-ulp `≈ M · 2⁻²⁴`; as a CONSERVATIVE per-store bound use
   a full ulp `M · 2⁻²³` (the spacing between consecutive f32, and what the gate's
   `ULP_F32` uses). The dominant term is the **largest intermediate magnitude** the
   path stores or computes in f32, times that ulp, times any downstream amplification.
   - Example (H2): the pre-#392 fill arm stored absolute lon/lat **degrees** and
     re-projected: `merc_x = lon·DEG2RAD·R`. At Seoul `merc_x ≈ 1.4e7 m`, so a
     single f32 holds it with ulp `≈ 1.4e7 · 2⁻²³ ≈ 1.7 m`. That 1.7 m is the
     error *floor* of the path, independent of zoom.
2. **Bound over the domain.** Convert metres → pixels via `pxPerM(zoom) =
   tileSize · 2^zoom / (2π·R)`. The leading-order budget is `boundPx(zoom) =
   dominantM · 2⁻²³ · pxPerM(zoom)`. For H2 at z20.55: `1.4e7 · 2⁻²³ · ~19.6 ≈
   1.7 m · 19.6 ≈ 33 px`. **The bug is a number you compute, not a thing you see.**
   (The empirical f32 split is ~1.7× larger, ≈57 px, because a second same-order
   term — the truncated f32 `DEG2RAD` constant, rel err ~1.4e-7 — adds a comparable
   contribution; the leading term decides the FRAME, step 5's empirical gives the
   exact magnitude.)
3. **Compare frames.** The #392 fix stores **tile-local** Mercator: magnitude `≤
   tile_extent(zoom) = 2π·R / 2^zoom`. Then `boundPx = tile_extent · 2⁻²³ ·
   pxPerM(zoom) = (2π·R/2^z)·2⁻²³·(tileSize·2^z/2π·R) = tileSize · 2⁻²³` — a
   **constant ≈ 6e-5 px at every zoom** (tileSize 512). The closed form *proves*
   tile-local is sub-pixel everywhere and absolute-degree is not. This is the whole
   #392 argument, derivable at design time.
4. **Gate it.** Assert `boundPx < pxTolerance` for every SHIPPING path over the
   domain. A path whose bound exceeds tolerance is a design-level bug — flag it
   before it renders.
5. **Validate the model (don't trust a hand-derived bound blindly).** Simulate the
   path in f32 (`Math.fround` each op) vs f64 truth over a **dense** zoom×lon grid;
   assert `empiricalMaxPx ≤ analyticBoundPx`. If the empirical exceeds the bound,
   your dominant-term model under-counts — fix the model. The empirical check is
   itself a cheap pre-observation gate (dense sampling of the *math*, not pixels).

The living gate: `runtime/src/engine/projection/coordinate-error-budget.test.ts`.
Add a coordinate path = add its error model + dense empirical row. It runs in the
normal vitest CI job (no GPU). Had it existed when the fill arm was written, its
abs-degree row would have rejected that frame at design — but note it is a
closed-form DESIGN proof, NOT a shader-regression guard (that is `#393`'s real-GPU
token-pin in `_polygon-fill-flat-parity.spec.ts`); the two are complementary.

## §2 Unrepresentable frame (frame-consistency class)

fill≠outline / CPU≠GPU / geoid are all "two paths disagree about the frame a point
lives in." Don't test that they agree — make disagreement **impossible to write**.

- One authority produces the canonical coordinate; give it a **branded type** (e.g.
  `type TileLocalMerc = number & { __brand: 'tileLocalMerc' }`) that only the
  authority can mint.
- Every consumer (every vertex arm, CPU and GPU packers) takes `TileLocalMerc`, not
  a raw `number`. A path that tries to feed raw degrees / a different frame is a
  **compile error**, not a screenshot diff.
- The latent siblings this catches here: the **extruded** fill arm
  (`vs_main_ecef_extruded`) unambiguously still positions via `project(f32 degree)`
  — the exact pre-#392 lossy path — and is gated by NOTHING (neither the budget test
  nor `#393`). The polygon **stroke** arm (`vs_main`) is also lossy, though whether
  the polygon tile OUTLINE renders through it or through line.ts's precise DSFUN
  `vs_line` needs one trace before acting. A branded `TileLocalMerc` feed would turn
  the unambiguously-lossy extruded arm into a compile error, not a latent deep-zoom bug.

This is the type-level form of the project's single-authority debt (the DSL unified
shader *text*, not the position *frame* — see the recurrence-bedrock memory).

## §3 Metamorphic invariants (geometric, oracle-free)

When there is no closed form and no reference oracle, assert a **relation** that
must hold without knowing the right answer:

- camera bearing +360° → identical output; world-copy ±360° lon translation → identical projected position (mod world width).
- zoom continuity: position(z) and position(z+ε) differ by `< ε·scale` (no jump).
- containment: every fill vertex lies inside its stroke/outline bounding region.
- seam continuity: `project_geom` is continuous across ±180 (no jump > tile_extent) — this catches the live `oblique-antimeridian` unwrap bug, which the parity gates miss because WGSL and the CPU mirror share the buggy DSL source (a parity test of two copies of the same bug passes).

These are CPU/compute, CI-able, oracle-free. They probe the un-oracle'd space a
parity test cannot.

## When to STILL observe

Only when the bug is **emergent raster** — a function of the rasterizer hardware,
with no analytic model: MSAA/seam pixel coverage, alpha blend, depth/overdraw
ordering, sub-pixel AA. For those, and ONLY those, use `visual-artifact-bisect`
(real-GPU headed screenshot bisect). If you find yourself reaching for a screenshot
for a precision or frame bug, you are about to start the dozens-of-attempts loop —
stop and write the budget instead.

## The honest claim boundary

This skill does NOT let you assert "no render bugs remain" — absence is unprovable
in a continuous, partially-oracle'd, GPU-composited domain. It lets you make the
*scoped, true* claim: "no bug of class C over domain D" — and it pulls the
precision and frame classes (the bulk of the recurrence) out of the
observation-bound set into the provable set, before any user reports them.

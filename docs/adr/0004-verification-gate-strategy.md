# ADR-0004: Two-tier verification — no-GPU CI vs real-GPU local

- **Status**: Accepted
- **Date**: 2026-06-02
- **Related**: `.github/workflows/test.yml`, `playground/playwright.config.ts`,
  `scripts/precheck.ts`, `docs/COORDINATES.md`,
  `docs/verification/STRATEGY.md` (companion how-to)

## Context

X-GIS render correctness lives in two places that the unit suite cannot
reach:

1. **GPU-executed shader math** — the WGSL string that actually compiles on
   the device. The TS-only suite (`projection-wgsl-consistency.test.ts`)
   compares the TS mirror against the CPU canonical; both are TypeScript, so a
   drift edit to `WGSL_PROJECTION_FNS` (a dropped `- PI/2`, a wrong constant)
   leaves every test green and ships a user-visible "geometry detaches under
   projection X" (see `playground/e2e/_shader-math-parity.spec.ts:1-16`).
2. **Rasterized pixels** — the final image. Whether a label lands on its
   feature, whether the globe/non-Mercator disc fills the canvas, whether a
   seam flickers. This needs a real raster pass.

GitHub Actions Linux runners have **no GPU**. The only WebGPU adapter
available there is **SwiftShader** (software Vulkan, forced via
`--enable-unsafe-swiftshader` / `--use-vulkan=swiftshader` — see
`playground/playwright.config.ts:73-84`). Two hard facts about SwiftShader on
this codebase, both recorded in-tree:

- **It cannot raster the X-GIS pipeline correctly.** Pixel-based assertions
  false-positive — the diffs are SwiftShader artifacts, not regressions
  (`test.yml:73-74`, `_projection-coverage.spec.ts:36-41`,
  `playwright.config.ts:69-72`).
- **Full render-pipeline init times out under it.** Specs that build the
  actual render pipelines (`_projection-coverage`, `_vs-pipeline-integrity`,
  `_globe-arena-pressure`) hang on WebGPU adapter init + shader compile + tile
  fetch and never reach their assertions (`test.yml:63-72`).

Separately, the **headless** Chromium path is itself unusable for rendering on
the dev box: headless fails to enumerate a hardware WebGPU adapter ("No
available adapters"), dropping the engine into the Canvas 2D fallback, which
can't parse XGVT tiles at all (`playwright.config.ts:57-64`). Real-GPU
rendering therefore requires **headed** Chromium on a machine with a real
D3D/Vulkan adapter.

So the question is not "CI or local" as a preference — it is forced: the only
gates that can run in CI are the ones that **never raster**.

## Decision

Split verification into two tiers by what each gate needs from the GPU.

```
                  ┌───────────────────────────────────────────────┐
                  │  GitHub CI  (ubuntu-latest, NO GPU, software)  │
                  ├───────────────────────────────────────────────┤
  test job        │  vitest  compiler/src blueprint/src            │
                  │  vitest  runtime/src        (split, see below) │
                  ├───────────────────────────────────────────────┤
  render-gate job │  SwiftShader, XGIS_SOFTWARE_GPU=1, HEADED=0    │
                  │   _shader-math-parity   (WGSL project() compute)│
                  │   _wgsl-compile-gate    (createShaderModule all)│
                  │   _vs-clip-parity       (VS clip compute)      │
                  │   _dequant-parity       (u16→f32 compute)      │
                  └───────────────────────────────────────────────┘
                              ▲  pure compute / compile only
                              │
        ─────────────────────┼─────────────────────────────────────
                              │  raster required
                              ▼
                  ┌───────────────────────────────────────────────┐
                  │  LOCAL / pre-push  (headed, REAL D3D/Vulkan)   │
                  ├───────────────────────────────────────────────┤
                  │  pixel-match survey (X-GIS vs MapLibre)        │
                  │  _projection-coverage   (paint-ratio checks)   │
                  │  _projection-label-onscreen, _label-anchor-…   │
                  │  globe / non-merc render matrices              │
                  │  autonomous screenshot-eyeball loop + humans   │
                  └───────────────────────────────────────────────┘
```

**Tier 1 — CI (no GPU).** Runs only gates that are pure compute or pure
compile, which SwiftShader executes correctly. Two jobs in
`.github/workflows/test.yml`:

- `test` — vitest over `compiler/src`, `blueprint/src`, then `runtime/src`.
  Split per workspace deliberately: a single combined run over ~555 files
  accumulates worker→main RPC state on the slow runner until
  `Timeout calling "onTaskUpdate"` fires — every test passes, the worker just
  can't report back in time (`test.yml:29-38`).
- `render-gate` — four `_`-prefixed specs under SwiftShader with
  `XGIS_SOFTWARE_GPU=1` and `HEADED=0` (`test.yml:95-100`):
  - `_shader-math-parity` — executes the real `WGSL_PROJECTION_FNS` in a
    compute pass and diffs `project()` against the TS mirror over a
    front-hemisphere grid for projTypes 0–6.
  - `_wgsl-compile-gate` — `createShaderModule()`s every emitted shader
    variant (polygon / line / point / raster / icon / overdraw / text) and
    asserts zero WGSL compile errors.
  - `_vs-clip-parity` — runs the vertex-shader clip math in a standalone
    compute pass, reads it back, compares GPU vs the CPU f32 mirror.
  - `_dequant-parity` — the u16→f32 dequant kernel, GPU vs CPU, standalone
    compute pass.

  All four are SwiftShader-safe because they **never paint** — they run
  `createComputePipeline` / `createShaderModule` and read back buffers.

**Tier 2 — local / pre-push (real GPU).** Everything that requires a raster
runs on a real adapter, headed:

- The X-GIS-vs-MapLibre **pixel-match survey** and the globe / non-Mercator
  render matrices.
- `_projection-coverage` — even under `XGIS_SOFTWARE_GPU=1` it **skips the
  paint-ratio checks** and keeps only the GPU-independent assertions (NaN
  matrix, `setProjection` alias misroute, console errors)
  (`_projection-coverage.spec.ts:36-41`). Its full paint gate is local-only.
- The label **position** gates (see below).
- The **autonomous screenshot-eyeball loop**: an executor runs headed on a
  real GPU, captures PNGs, and the orchestrating agent reads the images back —
  plus human review.

The pre-push hook (`scripts/precheck.ts`, armed by `bun setup:hooks` →
`.githooks`, `package.json:17-19`) runs the vitest tier by default and adds
`_projection-coverage` under `--smoke`. It mirrors CI, not the full local
raster tier, so push stays fast (`precheck.ts:1-21`).

### Sub-decision: pixel-match is non-gating for labels

The labels pixel-match survey **cannot** gate label fidelity. A multi-threshold
A/B proved that adding _correctly-placed_ labels _lowers_ the X-GIS↔MapLibre
pixel-match at every tolerance (through Δ≤128): the two engines render
different label sets and different font/halo, so label ink never pixel-aligns
(`_label-anchor-parity.spec.ts:5-18`). Label fidelity is therefore gated on
**position**, which is immune to those rasterization confounds:

- `_label-anchor-parity` — matches X-GIS placed anchors to MapLibre point
  symbols by text and asserts the vertical residual `ry = xgis.anchorY -
ml.project(lonlat).y` is sub-pixel. (Horizontal is intentionally not
  asserted: X-GIS reports the glyph-run left edge, MapLibre the center.)
- `_projection-label-onscreen` — asserts anchors stay on screen across all 8
  projections.

These run on real chromium WebGPU (Tier 2). The pixel survey remains a
diagnostic, not a gate.

### How CI keeps the math honest without a GPU

The SwiftShader compute tier is not a token gesture. Two cross-checks make it a
real regression catcher:

- **Tolerance is class-aware, not loosened blindly.** `_shader-math-parity`
  uses 100 m absolute on hardware (catches sub-permille drift) but
  `max(3000, |val|·2e-3)` under SwiftShader, because its software
  transcendentals are ~3e-4 relative (stereographic's `2/(1+cos_c)` amplifies
  to ~2.7 km). That is ~6× above SwiftShader noise yet far below any gross
  formula drift, which is whole-percent → hundreds of km
  (`_shader-math-parity.spec.ts:42-56`). Net contract: **CI catches gross WGSL
  / projection-math breakage; the tight hardware pre-push gate catches the
  subtle drift SwiftShader is too imprecise to see.**
- **Independent reference math.** `runtime/src/__tests__/cross-validation.test.ts`
  pins the CPU projection/tiling math against fixtures generated by
  pyproj / mercantile / shapely (`scripts/cross-validation/`) — a different
  codebase, so it catches "same bug in both CPU and WGSL", which intra-repo
  parity cannot (`cross-validation.test.ts:22-33`; cf. `docs/COORDINATES.md`
  cross-path-invariant discipline). This runs in the vitest tier, i.e. in CI.

## Consequences

**What CI guarantees on every push.** WGSL won't fail to compile (any emitted
variant), the GPU `project()` won't grossly diverge from the TS mirror, the VS
clip and dequant kernels match their CPU mirrors, the projection/tiling CPU
math matches the independent Python standards, and the full vitest logic suite
(camera math, slice-key invariants, filter routing) is green. A projection-math
or WGSL regression fails CI, not just a human eyeball — which was deep-dive
finding #1 on 2026-05-25: _the unit suite never executes a shader_
(`test.yml:40-43`).

**What CI does NOT guarantee — by design.** Anything that needs a correct
raster: pixel parity with MapLibre, globe/non-Mercator disc coverage, label
placement, seam/flicker artifacts, paint-ratio. These are caught by the
real-GPU local / pre-push tier, the autonomous screenshot-eyeball loop, and
human review. This is a **deliberate split, not a coverage gap**: SwiftShader
_cannot_ validate them (false-positive diffs) and _cannot even initialize_ the
specs that would try (pipeline-init timeout). Putting them in CI would add red
noise, not signal.

**Promotion path.** A Tier-2 gate moves to Tier-1 only after it is shown to run
correctly on a software GPU. `_vs-clip-parity` and `_dequant-parity` were
promoted from local-validated to CI-enforced this way; `_vs-pipeline-integrity`
and `_globe-arena-pressure` remain Tier-2 candidates pending a software-GPU run
(`test.yml:54-72`). The lasting unlock for the raster gates is a **GPU-enabled
CI runner**: `playwright.config.ts:62-63` and the e2e AGENTS note both flag
`HEADED=0` as "only once we have a working GPU-enabled runner". Until then the
split holds.

**Risk owned.** A purely visual regression that does not touch shader math,
clip math, or projection formulas can pass CI and reach a branch. Mitigation is
procedural: pre-push smoke + the screenshot-eyeball loop + human review before
merge of any render-path change. The render-coordination bug sweep
(2026-06-01) is the working example of that loop catching what CI structurally
cannot.

## See also

- `docs/verification/STRATEGY.md` — operational how-to: which command runs
  which tier, how to rebake baselines, how to drive the eyeball loop.
- `docs/COORDINATES.md` — the cross-path-invariant discipline the
  cross-validation tier enforces.
- `.github/workflows/test.yml` — the executable form of this decision.

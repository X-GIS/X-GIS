# X-GIS verification strategy — the ratchet

How X-GIS proves correctness, and why each gate runs where it runs.

The core constraint shapes everything below: **GitHub CI has no GPU.** The
runner falls back to SwiftShader (software WebGPU), which can run pure
_compute_ and _shader compilation_ but **cannot raster the X-GIS pipeline
correctly** — pixel assertions there false-positive. So the verification
work splits along one hard line:

```
                  CI (no GPU, SwiftShader)          LOCAL / pre-push (real GPU)
  ┌──────────────────────────────────────┐  ┌──────────────────────────────────┐
  │ vitest unit (no shader executes)      │  │ pixel-match survey (4 views)      │
  │ _shader-math-parity   (compute)       │  │ _projection-coverage (full engine)│
  │ _wgsl-compile-gate    (compile only)  │  │ _globe-ecef-render-position        │
  │ _vs-clip-parity       (compute)       │  │ _projection-label-onscreen         │
  │ _dequant-parity       (compute)       │  │ _label-anchor-parity               │
  └──────────────────────────────────────┘  │ headed-screenshot eyeball loop     │
                                             └──────────────────────────────────┘
            ↑ compute / compile                       ↑ render-correctness
```

**CI = compute/compile only. Render-correctness = local, real GPU.**
That sentence is the whole strategy. Everything else is detail.

Source of truth for the gate wiring: `.github/workflows/test.yml`.

---

## Tier 1 — vitest unit (the CI `test` job)

`.github/workflows/test.yml` `test` job: after `bun install` + `bun run
build`, it runs vitest **split per workspace**:

```yaml
- run: ./node_modules/.bin/vitest run compiler/src blueprint/src
- run: ./node_modules/.bin/vitest run runtime/src
```

**Why split.** Per the comment in `test.yml`: a single combined run over
all ~555 files accumulates worker→main RPC state on the slower CI runner
until `[vitest-worker]: Timeout calling "onTaskUpdate"` fires — every test
_passes_, the worker just can't report progress back in time. Two separate
runs each start a fresh worker pool well under that threshold
(compiler+blueprint ~329 files, runtime ~226). The same worker-IPC timeout
flake is why `scripts/precheck.ts` carries `parseTestOutcomeFromStdout`:
it treats `1 error / 0 failed` (the teardown-race "Unhandled Errors"
bucket) as success when the _test-failure_ count is zero.

**What this tier does NOT do.** The unit suite **never executes a shader**
— flagged as finding #1 of the 2026-05-25 deep-dive, and recorded directly
in the `render-gate` comment of `test.yml`. The pre-existing
`projection-wgsl-consistency.test.ts` compares the TS mirror against the
CPU canonical — _both TypeScript_. It never runs the actual WGSL string
that compiles on the GPU. So projection-math correctness needs Tier 2.

`bun precheck` (wired as the git **pre-push** hook via `bun setup:hooks`
→ `.githooks/pre-push`) runs exactly this vitest tier locally before the
network round-trip. `bun precheck:smoke` adds `_projection-coverage`.

---

## Tier 2 — CI render-gate under SwiftShader (the `render-gate` job)

`.github/workflows/test.yml` `render-gate` job runs Playwright with:

```yaml
env:
  XGIS_SOFTWARE_GPU: '1'
  HEADED: '0'
run: ./node_modules/.bin/playwright test \
  _shader-math-parity.spec.ts _wgsl-compile-gate.spec.ts \
  _vs-clip-parity.spec.ts _dequant-parity.spec.ts
```

These four — and **only** these four — run in CI, because each is
**pure compute or pure compilation**, which SwiftShader handles. Raster
does not run here.

| Gate                  | What it executes                                                                                                                                                                                                                      | Why SwiftShader-safe                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_shader-math-parity` | The real `WGSL_PROJECTION_FNS` `project()` in a **compute pass**, diffed against the TS mirror `projectWgsl()` over a front-hemisphere lon/lat grid, projTypes 0–6.                                                                   | Pure arithmetic — no raster. Closes deep-dive finding #1 (no test executed real WGSL).                                                                             |
| `_wgsl-compile-gate`  | `createShaderModule()` over **every** emitted variant (polygon base fixtures, line ±pick, line-composite, point, raster ±pick, icon, overdraw compose/fs, text); asserts `getCompilationInfo()` reports zero error-severity messages. | Compilation needs no raster. Catches a variant that emits a string the GPU compiler rejects ("nothing renders for layer/projection X").                            |
| `_vs-clip-parity`     | `clip = mvp * vec4(dequant_ecef(q), 1)` (the coordinate core of `vs_main_ecef`) in a standalone **compute pipeline**, read back via `mapAsync`, GPU f32 vs CPU `mulMat4Vec4F32` mirror.                                               | Pure compute. Promotes the CPU mirror the extruded/ECEF gates rely on from locally-validated to CI-enforced.                                                       |
| `_dequant-parity`     | The shared `dequant_ecef` DSL fn (u16→f32 decode) in a **compute pass**, GPU vs CPU `dequantVertexF32` (`Math.fround` model) across per-tile ranges z0→z22.                                                                           | Coordinate decode is pre-rasterization. Validates the CPU fround model _faithfully_ represents real GPU f32, so the mirror can gate precision in CI without a GPU. |

### Tolerance is GPU-class-aware

`_shader-math-parity` does not use one fixed tolerance — SwiftShader's
software transcendentals (log/tan/sin/cos) are measurably weaker than
hardware. From the spec header:

```
Hardware (local / pre-push): 100 m absolute.
  f32 + the WGSL's truncated constants diverge only ~5–10 m at Mercator
  scale (±2e7 m) — catches even a sub-permille formula drift.

SwiftShader (CI, XGIS_SOFTWARE_GPU=1): ~3e-4 relative noise
  (stereographic's 2/(1+cos_c) amplifies to ~2.7 km at 9.5e6 m).
  → CI tolerance: max(3000 m, |cpuVal| * 2e-3)  ~6× above SwiftShader noise.
```

Net contract: **CI catches _gross_ shader-math breakage** (a dropped term,
wrong sign, wrong constant — whole-percent, hundreds of km); **the tight
hardware gate (pre-push) catches the subtle drift SwiftShader is too
imprecise to see.** The two tiers cover different sensitivity bands of the
same `project()`.

### Why other gates are NOT in CI

Documented in the `render-gate` comment block of `test.yml`:

- **`_projection-coverage`** needs the full engine (render pipelines) to
  initialise; SwiftShader can't, so cells time out → local / pre-push.
- **`_vs-pipeline-integrity` / `_globe-arena-pressure`** build the full
  _render_ pipelines (arena-pressure also streams tiles) — same
  SwiftShader init path that times `_projection-coverage` out. Candidates
  for CI once validated on a software-GPU run; local / pre-push for now.
- **pixel survey** — SwiftShader can't raster X-GIS correctly →
  false-positive diffs. Local / pre-push only.

---

## Tier 3 — LOCAL / pre-push real-GPU gates

These require a hardware GPU (the playground default: HEADED, system
D3D/Vulkan adapter, **no** `XGIS_SOFTWARE_GPU`). They drive real render
pipelines and read back the rendered texture — the path SwiftShader times
out on. Each spec header marks itself a HARDWARE / PRE-PUSH GATE.

### 3a. Pixel-match survey vs MapLibre

`playground/e2e/_pixel-match-survey.spec.ts` sweeps the compare runner
across **4 representative views**, labels + icons OFF on both sides (so the
diff isolates fill / line / outline). MapLibre is the canonical reference.
The diff is bucketed by max-channel delta: `eq0` (identical), `le8…le128`,
`gt128` (worst-case drift).

Each view carries **two regression gates** (`ViewSpec`):

| View                  | style / hash                                   | `gt128Threshold` | `eqFloorPct` |
| --------------------- | ---------------------------------------------- | ---------------- | ------------ |
| `bright-seoul-school` | openfreemap-bright `#17.85/37.12665/126.92430` | 5                | 90           |
| `bright-tokyo-z14`    | openfreemap-bright `#14/35.6585/139.7454`      | 20               | 25           |
| `liberty-paris-z14`   | openfreemap-liberty `#14/48.8534/2.3488`       | 1200             | 16           |
| `demotiles-europe-z2` | maplibre-demotiles `#2.5/48/15`                | 10000            | 60           |

- **`gt128Threshold`** — spec FAILS if `buckets.gt128` exceeds this. Each
  value is the 2026-05-18 baseline plus antialiasing/cross-driver
  headroom. Wide where warranted: demotiles is `10000` because a
  non-deterministic ancestor-tile LRU at convergence makes its z0/z1
  protected ancestors (and their edge-AA contribution vs MapLibre) vary
  ±30 entries run-to-run; tightening requires a runtime-side deterministic
  LRU tie-breaker on `(lastUsedFrame, tileKey)`.
- **`eqFloorPct`** — spec FAILS if exact-match % (`eq0 / totalPx`) drops
  **below** this floor. This gate exists because **`gt128` alone is blind
  to whole-frame _moderate_ shifts** (header, 2026-05-25): a probe that
  halved every polygon fill's alpha (`out.color.a * 0.5`) left `gt128`
  essentially unchanged on all four cells — yet `eq` cratered (seoul
  97.28→11.90, demo 87.71→33.83). `eq0` is the canary for
  alpha/color/gamma/whole-frame drift; floors are baseline-minus-headroom.

The two thresholds are complementary: `gt128` catches _local sharp_
divergence, `eqFloorPct` catches _global soft_ shift. (Note: the absolute
`eq` baselines drift run-to-run on the LRU-bimodal cells, which is why the
gate is the _floor_, not the exact number.)

Run via `bun test:pixel`.

### 3b. Projection coverage matrix

`playground/e2e/_projection-coverage.spec.ts` sweeps **8 projections ×
zoom**, **8 × pitch (0→75°)**, plus a `setProjection()` switch sequence
(verify post-switch frame is sane — no NaN matrix, no 0-paint, no GPU
state corruption across switches). It is page-reuse designed (mount once,
mutate `location.hash`) to skip per-cell WebGPU init.

It is dual-purpose: when `XGIS_SOFTWARE_GPU=1` it **skips the paint checks
but keeps the GPU-independent assertions** (NaN/Infinity matrix, alias
misroute `projectionName != requested`, console errors). That is why
`bun precheck:smoke` and a future CI promotion can run it under
SwiftShader for the silent-bug catchers, while the _paint-ratio_ assertion
stays real-GPU-only. Run via `bun test:projection`.

### 3c. Globe / ECEF render-position gates

`_globe-ecef-render-position.spec.ts` (and the extruded variant) drive a
**real WebGPU render pipeline and read the rendered texture back** to prove
a far globe tile lands at its _true_ screen position rather than
collapsing onto the camera-origin tile (the #198 `+cam_ecef_off` recentre
fix). They are explicitly **NOT** CI render-gates: on the no-GPU runner
`createRenderPipeline` of a real vertex shader times out. The oracle is the
same production mirror chain the Tier-2 compute-parity gates validate
against the GPU — `dequantVertexF32` → `+cam_ecef_off` →
`Camera.getECEFFrameView(...)` MVP → NDC → pixel — so a few-px match proves
the whole vertex path, not just the compute kernel.

### 3d. Label position gates (NOT pixel)

Label fidelity is gated on **position, not pixels** — proven necessary
because the labels pixel-match survey _cannot_ gate it: adding
correctly-placed labels lowers the X-GIS↔MapLibre match at _every_
tolerance (the two engines render different label sets + font/halo, so
label ink never pixel-aligns).

- **`_label-anchor-parity`** — matches X-GIS placed anchors to MapLibre
  point-symbol features by text and asserts the **vertical** residual
  `ry = xgis.anchorY − mapLibre.project(lonlat).y` is sub-pixel.
  (Horizontal is intentionally not asserted: anchorX is the glyph-run left
  edge vs MapLibre's center.)
- **`_projection-label-onscreen`** — across all 8 projections at a city
  zoom (+ pitch), every drawn label anchor must sit within viewport +
  margin. This catches the azimuthal-mispositioning class (projType 3/4/5
  falling to the Mercator-frustum tile selector → labels dispatched from
  the _wrong_ tiles → anchors land far off-viewport).

### 3e. The headed-screenshot eyeball loop

For visual bugs not yet reduced to a numeric invariant, the workflow is an
autonomous capture loop: a headed real-GPU Playwright spec drives the demo
to a camera state and writes a PNG (the `_*.spec.ts` capture specs write
under `playground/e2e/__*__/` directories — e.g.
`__projection-coverage__`, `__explore-map-qa__`). The reviewer then reads
the PNG and decides pass/fail. This is the front line where a new render
bug is first _seen_; once characterized, it gets promoted into a numeric
gate (3a–3d) so the regression can never return silently.

---

## Tier 4 — cross-validation (independent reference)

`scripts/cross-validation/` pins X-GIS's **CPU** projection/tile/geometry
math against _independent_ reference implementations — a different
codebase, authors, and maintainers:

- **pyproj** — projection transforms (Mercator forward + inverse, etc.)
- **mercantile** — slippy-map tile math (lon/lat ↔ tile x/y, tile bounds)
- **shapely** — geometric ops (area, intersection, containment)

(versions pinned in `scripts/cross-validation/pyproject.toml`:
`pyproj>=3.6`, `mercantile>=1.2`, `shapely>=2.0`.)

`generate-fixtures.py` (run via `uv run generate-fixtures.py`) emits a
committed fixture at `runtime/src/__tests__/cross-validation.fixture.json`;
`cross-validation.test.ts` (vitest, in the Tier-1 `runtime/src` run) loads
it and compares X-GIS's own CPU implementations against these reference
values.

**Why it exists** (from `cross-validation.test.ts`): the rest of the suite
verifies our CPU matches our WGSL — that catches intra-repo divergence but
**not "same bug in both"**. The Python libraries are the de-facto standards
for their domains, so a drift from the documented standard is caught even
when the X-GIS CPU/WGSL pair stays internally consistent. Regenerate the
fixture only when a projection/tile formula _intentionally_ changes.

(Companion ground-truth: `docs/COORDINATES.md` pins which coordinate space
each tile-pipeline stage operates in — the convention these formulas must
honor.)

---

## The ratchet — how this keeps quality from regressing

The tiers form a ladder where each rung catches a class the rung below is
blind to, and a real GPU bug walks _up_ the ladder into a permanent gate:

```
  seen first ─────────────────────────────► pinned forever
  ┌──────────────────┐
  │ eyeball loop     │  visual, real GPU, human-in-loop
  └──────────────────┘
        │ characterize → numeric invariant
        ▼
  ┌──────────────────┐
  │ Tier 3 (local)   │  pixel survey / projection-coverage / position gates
  └──────────────────┘  (real-GPU render-correctness)
        │ reduce to compute / compile
        ▼
  ┌──────────────────┐
  │ Tier 2 (CI)      │  shader-math / wgsl-compile / vs-clip / dequant parity
  └──────────────────┘  (SwiftShader-safe, blocks the merge)
        │ pure CPU mirror
        ▼
  ┌──────────────────┐
  │ Tier 1 + Tier 4  │  vitest unit + independent (pyproj/mercantile/shapely)
  └──────────────────┘  (no GPU at all, fastest, runs on pre-push)
```

The split-by-GPU-availability is the load-bearing design choice:
because CI has no GPU, anything render-correctness lives at Tier 3 and
runs on the dev box / pre-push; CI defends only what SwiftShader can
faithfully execute (compute + compile), and does so as a **merge blocker**.
A regression that escapes CI is, by construction, a _render_ regression —
which is exactly what the local real-GPU tiers and the eyeball loop are
positioned to catch before push.

---
name: measure-harness
description: >
  Get REAL-HARDWARE render measurements from the user (or headless
  SwiftShader measurements yourself) with one URL — the in-page harness at
  `?measure=<scenario>` drives repro cameras, converges the engine, reads
  the canvas back and reports cross-section numbers as copyable JSON. Use
  whenever hardware truth is needed to attribute a render defect ("looks
  wrong on my machine", quality comparisons the cloud container cannot
  see, SwiftShader-vs-hardware splits like #2025/#2053), instead of asking
  for screenshots. Also the headless A/B recipe reading
  `__xgisMeasureReport`, and how to read/compare reports.
---

# measure-harness — one URL, same numbers, any GPU

The cloud container renders only on SwiftShader; a user's report is about
their real GPU. Screenshots can't be compared numerically and every ad-hoc
probe re-invents its analysis. The harness (`playground/src/measure-harness.ts`)
is ONE measurement authority with two consumers: a human on hardware, and a
headless probe on SwiftShader — identical code, comparable JSON.

## Asking the user to measure (the whole point)

Give them ONE URL on their dev server (or ask them to pull main first if the
fix under test just merged):

```
https://localhost:3000/demo.html?id=import_maplibre_mirror&e2e=1&adaptive=0&measure=proj-parity
```

They wait for the overlay to say **done** (hardware: tens of seconds;
each cell converges in ~1-2s there) and click **Copy report JSON** —
the clipboard content is the deliverable. Nothing else to install or run.
`id=import_maplibre_demo` (live demotiles) also works on machines with
egress; the mirror needs none.

## Running it yourself (SwiftShader side of the A/B)

```bash
cd playground && XGIS_SOFTWARE_GPU=1 HEADED=0 \
  XGIS_CHROMIUM_EXECUTABLE=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | head -1) \
  ./node_modules/.bin/playwright test <a-spec-that-opens-the-url>
```

The spec shape: goto the same URL, `waitForFunction` on
`window.__xgisMeasureDone === true` (budget 570s — SwiftShader cells
legitimately take 10-100s each), then `page.evaluate` read
`window.__xgisMeasureReport`. No screenshots, no sleeps — the harness owns
its own convergence (and actively pumps `invalidate()` while work is
pending, so the SwiftShader upload-backlog freeze cannot produce a stale
frame).

## Reading a report

Per cell (`slug`, `proj`, `camera`), per row:

- **`runs`** — the primary diagnostic: stroke runs as `[x0, x1, pattern]`
  with one char per device pixel (`B` coastline-blue, `W` boundary-white,
  `.` a ≤3px gap). Shapes to know on the demotiles Korea cells:
  - `WWWBB`-class (white then blue seaward) = CORRECT MapLibre stock-order
    look (fill covers blue's land half; white core + blue water fringe).
  - `W`-only, or a lone 1px `B` = the #2053 under-fill stroke loss.
  - `BWWWB` = both-after-fill order (full sandwich).
- **`registrationCss`** — fill-edge-adjacent-to-first-run minus run center,
  CSS px. NOT zero-centered in absolute terms (the visible fill edge is
  itself occluded by strokes); compare the SAME cell/row ACROSS reports
  (hardware vs SwiftShader, globe vs mercator). SwiftShader baseline
  (2026-08-25, mirror): globe-z9 ≈ +2 where merc-z9 ≈ ±3.5 mixed — a
  hardware report matching mercator's numbers on the globe cells means the
  residue is SwiftShader-only (#2025); reproducing +2-class divergence on
  hardware escalates #2053.
- **`convergedMs` / `residualPending*`** — a non-zero residual means the
  cell frame is NOT converged; treat its rows as unreliable and say so.
- **`backend` / `adapter` / `dpr`** — attribution. `adapter` comes from a
  fresh `requestAdapter()` (best-effort; null on WebGL2-only machines).

## Extending

Scenarios are data (`SCENARIOS` in `measure-harness.ts`): cells
(proj+camera), fractional rows, stroke/fill color classes, budget. Add a
scenario for a new investigation rather than hand-rolling another probe;
keep classes tolerant (AA blends) and validate any new scenario against a
known positive before trusting it (§12: a zero from an unvalidated
instrument is a broken ruler, not a clean corpus).

## Traps

- The harness reads the CANVAS (`toBlob`, the captureMapSnapshot pattern) —
  demo chrome cannot pollute it, but `preserveDrawingBuffer`/present timing
  means it always `invalidate()`s and waits two rAFs before reading.
- Runtime `setProjection` + `jumpTo` between cells — no reloads; a
  scenario's cells share one page session and one style.
- Row indices are device px; reported x values are CSS px (÷dpr) so
  reports from dpr=2 laptops compare directly with dpr=1 CI.

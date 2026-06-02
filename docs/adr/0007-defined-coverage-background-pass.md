# ADR-0007: Defined coverage — the background pass, and the deliberate reversal of the black-outside-world clear

Status: Accepted (redesign step 0 — first coverage fix)
Date: 2026-06-02
Supersedes: the clear-value sub-decision of [ADR-0005](0005-synthetic-earth-surface-background.md) (§Decision bullet 4, §Consequences "Clear semantics unchanged").

## Context

A 56-cell real-GPU render-matrix sweep (`docs/redesign/VISION.md`) showed a
recurring defect: the region OUTSIDE the projected world band — the low-zoom
letterbox, the sky above a pitched horizon, the area around a shrunk disc —
rendered as a raw black void. This is the user's original complaint ("빈 영역은
배경색이어야 한다" — empty areas should be the background colour).

[ADR-0005](0005-synthetic-earth-surface-background.md) made that black
**deliberate**: the synthetic earth-surface paints the style `background-color`
only *inside* the world band, and the opaque pass's first sub-pass cleared the
colour target to pure black `{0,0,0,1}`, "the iter-196 MapLibre parity contract"
(opaque-pass.ts:86-95) — MapLibre shows black for the "no world here" region, so
matching it restored pixel parity at the z=0 + pitch cell.

So the void was **not an accident** — it was a chosen MapLibre-parity convention.
The redesign vision (§1, §4, §5 gap #1) reframes the goal: for the CORE
(`mercator`, `globe`) and SHOWCASE (pseudo-cylindrical) tiers, **every viewport
pixel must have a *defined* source — none may fall to black by accident.** That
requirement outranks MapLibre pixel-parity at the letterbox / above-horizon
cells. This ADR records the deliberate reversal.

## Decision

**A dedicated background pass (bucket 0) runs FIRST and owns the whole-viewport
colour clear, with a projection-aware clear colour.**

- `runtime/src/engine/render/passes/background-pass.ts` — a stateless pass
  inserted before the opaque pass (`render-loop.ts`). It owns the colour clear
  that previously lived in the opaque pass's first sub-pass. The opaque first
  sub-pass now `loadOp: 'load'`s the colour the background pass left; **depth /
  stencil / pick clears stay in the opaque pass** (bucket-1 concerns).

- The clear colour is a pure function of the resolved projection + the style
  background — `backgroundClearValue(projType, bg, overdraw)`:

  | case | clear |
  |---|---|
  | `?debug=overdraw` (any proj) | `{0,0,0,0}` — r16float accumulator starts at 0 |
  | flat / cylindrical (`worldBand ≠ 'sphere-full'`: mercator 0 / equirect 1 / natural_earth 2 / oblique 6) | the style `background-color` — the WHOLE viewport is the background |
  | disc / globe (`worldBand === 'sphere-full'`: ortho 3 / azimuthal 4 / stereo 5 / globe 7) | defined pure-black **space** |
  | flat with no `background` block (`bg = null`) | defined black |

  For flat projections the inside-band synthetic earth-surface (ADR-0005)
  redraws the same colour on top of the clear, so the band and its surround are
  seamless — there is no longer a band boundary where black shows through.

- **This DELIBERATELY reverses the iter-196 black-outside-world convention for
  CORE/SHOWCASE.** Disc/globe space stays black by choice (the user selected
  "defined pure-black space"; the atmosphere limb-glow is a separate, deferred
  pass — VISION §2.3).

```
 ┌──────────────────────────────────────────────────────────────┐
 │ bucket 0  background pass   clear = backgroundClearValue(...)  │ ← whole viewport
 │            (flat → style bg · disc/globe → black space)        │
 ├──────────────────────────────────────────────────────────────┤
 │ bucket 1  opaque pass       colour loadOp:'load'               │
 │            depth/stencil/pick still cleared here               │
 │            draw #0 synthetic earth-surface (inside band)       │ ← same bg, on top
 │            draw #1..N real tiles                               │
 └──────────────────────────────────────────────────────────────┘
```

## Verification

The screenshot is only how we *see* it; the gate is a deterministic numeric
invariant (VISION §6, re-anchoring on `docs/verification/STRATEGY.md`):

- **`backgroundClearValue` behavioural unit test**
  (`background-pass-clear-value.test.ts`) — flat → bg, disc/globe → black,
  overdraw → a:0, no-bg → black. Pure function, no GPU.
- **Real-GPU coverage gate** (`playground/e2e/_coverage-black-ratio.spec.ts`,
  local/headed — CI has no GPU per ADR-0004): flat CORE/SHOWCASE
  `world` + `world-pitch` views must be **≤ 2% pure-black** (measured **0.00%**
  on mercator / equirect / natural_earth). Disc/globe captured for eyeball +
  a not-all-black smoke (ortho 6.1% black, globe 30.8% — the space around the
  disc/sphere).

## Consequences

- **Positive.** No accidental black void on flat CORE/SHOWCASE at any pitch /
  zoom. One owner (the background pass) for the whole-viewport coverage — the
  insertion seam VISION §5 gap #1 named. The opaque pass is now a pure geometry
  bucket for colour (it still owns depth/stencil/pick).

- **MapLibre divergence is intended.** The `_pixel-match-seoul-zoom-matrix`
  report (no hard assertion) will show increased divergence vs MapLibre at the
  `z=0 p=60` cell, because X-GIS now paints the style background above the
  horizon where the iter-196 contract painted black. This is the chosen reversal,
  not a regression. Top-down city views (the 4-view pixel-match survey) are
  unaffected — they have no outside-band region, so X-GIS output there is
  byte-unchanged.

- **Scope / deferred.** (1) Disc/globe "space" is flat black — the atmosphere
  scattering pass is deferred (VISION §2.3). (2) Flat coverage is a clear
  *colour*, not a fullscreen quad — it handles the common opaque-`background`
  case; a `background-color` with alpha < 1 clears premultiplied-ish (rare edge).
  (3) The MSAA resolve-owner centralization (VISION's original "Step 0") was
  **deferred**: a first-running pass is never the last colour writer, so it never
  claims `resolveTarget` — centralization is only needed when a *late* colour
  pass (the atmosphere pass) is added, and is tracked with that work.

- **Supersedes ADR-0005's clear semantics.** ADR-0005 §Consequences said "Clear
  semantics unchanged … pinned by `opaque-pass-clear-value.test.ts`." That test
  moved to `background-pass-clear-value.test.ts` (now behavioural), and the clear
  is projType-aware and owned by the background pass. ADR-0005's
  synthetic-earth-surface inside-band fill is otherwise unchanged.

## References

- `runtime/src/engine/render/passes/background-pass.ts` — the pass + `backgroundClearValue`
- `runtime/src/engine/render/passes/opaque-pass.ts` — colour now `loadOp:'load'`; depth/stencil/pick clears retained
- `runtime/src/engine/render-loop.ts` — bucket-0 registration; `RenderLoopHost._backgroundColor`
- `runtime/src/engine/projection/projections-table.ts` — `worldBandForProjType` (the flat-vs-sphere classifier)
- `runtime/src/engine/render/passes/background-pass-clear-value.test.ts` — behavioural contract (relocated from opaque)
- `playground/e2e/_coverage-black-ratio.spec.ts` — the real-GPU numeric gate
- `docs/redesign/VISION.md` — §1, §4, §5 gap #1 (the requirement + the reversal)
- [ADR-0005](0005-synthetic-earth-surface-background.md) — inside-band synthetic earth-surface (superseded clear-value sub-decision)

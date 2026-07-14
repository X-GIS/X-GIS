---
title: 'Two renderers, one truth: all four globe bugs lived in the hand-maintained twin'
description: 'A displaced vector layer, a red/blue checkerboard ocean, a 16-gon planet, and intermittent flicker — four user-visible globe defects on WebGL2, and not one root cause in shared code. Every camera rendered correctly on WebGPU. On why a hand-maintained backend twin is scaffolding that must die, and the 20.7 km test witness that keeps its seam from drifting while it lives.'
date: 2026-07-13T20:00:00Z
tags: ['webgl2', 'rendering', 'architecture', 'debugging']
lang: en
series: { name: 'WebGL2 backend program', order: 8 }
draft: false
---

Four bug reports came in against the 3D globe: the whole vector layer drawn
displaced from the raster underneath it (#1044), the ocean rendered as a
red/blue checkerboard (#1041), the planet's silhouette visibly polygonal —
roughly a 16-gon (#1040), and intermittent whole-frame flicker (#1043).

Before reading any code we established one fact, headlessly, on SwiftShader:
at the identical camera, with the identical style, every one of the four
reproduced on the WebGL2 frame and none reproduced on WebGPU.

That symmetry is the whole diagnosis. Our WebGL2 backend is not just a second
RHI implementation; parts of the frame are a **twin** — hand-maintained
dispatch paths (`renderFillsRhi`, `renderLinesRhi`, a forced-WebGL2 render
loop) that re-state what the WebGPU frame does. Four defects, four unrelated
subsystems — uniform packing, background policy, tessellation density, GL
state — and all four root causes lived in the twin's copy, zero in the shared
engine. Here is each one, and then what that tally forces you to conclude.

## The zero that was correct on one projection

The twin's fill and line packs wrote the camera-relative ECEF offset like this:

```ts
B.set.cam_ecef_off_h(0, 0, 0, 1)
B.set.cam_ecef_off_l(0, 0, 0, 1)
```

Hard zeros in the xyz lanes (the `1` in `.w` is an unrelated flag lane). Those
lanes are the DSFUN hi/lo split of `tileEcefCenter − cameraCenter` — the
recentring that lets f32 vertex math survive planet-scale coordinates. On
every flat projection the vertex shader ignores them, so the zeros were
_correct_ for as long as the twin only drew flat maps. On the globe, every
vector vertex reconstructed against the wrong ECEF origin, and the entire
vector layer rendered at a displaced transform — a measured double image
against the raster below it (#1044).

The fix is an extraction, not a patch: `computeTileCameraAnchor`
(`map/src/render/tile-camera-anchor.ts`), pulled verbatim from the WebGPU
path's per-tile write, with all four packers — `renderTileKeys`, both RHI
twins, and the fill-bake block — routing through it. One authority; the
seam physically cannot drift while it stands.

### The guard that would have passed on the bug

The interesting part is the drift-guard test. The regression class here is
"someone recomputes the anchor with the wrong geoid" — an ellipsoid tile term
against a spherical camera term. The naive guard compares a full-sphere anchor
(E2 → 0 everywhere) against the ellipsoid one and asserts they differ. That
test **passes on the healthy code and would keep passing on the bug**: with
both terms on the sphere, the ellipsoid−sphere bias cancels between two
points ~1 km apart in the RTC _difference_, leaving ~0.7 m — inside any
tolerance you'd write. The 21 km-class error only appears when the geoids are
_mixed_, so the guard forces E2 → 0 on the camera term alone:

```ts
// Force E2→0 on the CAMERA term only (ellipsoid tile vertices + spherical
// camera origin) — the #1044-adjacent regression the authority names.
const sphereCameraOffZ = refEcef(c, E2, 0).offZ
expect(Math.abs(ellipsoidOffZ - sphereCameraOffZ)).toBeGreaterThan(10_000)
```

At Tokyo z14 the witness measures ~20.7 km of `offZ` shift — sub-pixel at
z1.5, thousands of pixels at z14. The same test pins the seam shut with
source gates: exactly 4 authority call sites, exactly 1 remaining deliberate
hard-zeroed ECEF write (the fill-bake's tile-local ortho), exactly 2 inline
Mercator-Y conversions.

## The debug fixture with a production audience

The forced-WebGL2 render loop drew our US-003/US-004 analytic red/blue
checker — a live-render test fixture — as the `else` of "is a raster source
configured". That read as harmless test scaffolding, because who runs the
forced-WebGL2 frame without a source? Answer: **every user whose browser
lacks WebGPU**, because the default provider chain auto-falls back to WebGL2.
A production sourceless frame showed a test pattern as the ocean. WebGPU,
at the same camera, draws nothing sourceless — its `render()` early-returns.

```ts
// #834 M5 slice 2 — real raster tile sources on WebGL2. With a source
// configured, the SAME render() the WebGPU frame uses draws the tiles;
// a sourceless production frame draws nothing (WebGPU parity, #1041)
// unless DEBUG_RHI_CHECKER opts in.
if (this.host.rasterRenderer.hasSource()) {
```

The checker now lives behind `?debug=checker`, and the two e2e gates that had
calibrated on it opt in via the flag. We had already written up how [a silent
backend fallback makes green tests ambiguous](/blog/2026-07-11-green-on-the-wrong-gpu);
this is the same chain making a debug fixture _reachable_.

## The compile-time planet

The raster surface mesh is procedural — `vs_tile` synthesizes the grid — and
its density was a compile-time literal `8`, with the matching draw count `384`
duplicated at the call site. A z0 tile spans the entire world; eight
subdivisions across 360° of longitude leaves the limb a polygon you can count
edges on. The exact defect class had already been found and fixed in the
_vector_ earth surface (32×16 → 128×64, userbug 09) — and never ported to the
twin's raster mesh. A fix that has to be applied twice is a fix that gets
applied once.

Now `rasterGridN(projType, tileZoom)` is the single ladder authority — globe:
`128 >> zoom` clamped to [8,128], so z0:128, z1:64, z2:32, z3:16, z4+:8; flat
projections keep 8×8 untouched — with N threaded per tile through the
uniform's former `_pad` lane (renamed `grid`, byte layout identical) and the
draw count derived by `rasterGridVertexCount(N)`. One footnote worth keeping:
the first version of the ladder dispatched on a raw `projType === 7`, and
CI's projection-confinement ratchet (#996) rejected it — even the fix got
caught reasoning by identity instead of by table.

## glClear honours the mask you forgot you set

The flicker was the oldest kind of GL bug: leaked global state. Our
`setPipeline` re-applies its state on every bind, so leaks can only hurt the
operations _between_ pipelines — the clears and dispatches. `beginScreenPass`
cleared colour without unmasking first, and `glClear` honours `colorMask`.
An all-false colour mask is not a hypothetical: a stencil-only clip pass and
a writeMask-0 pick pass both end frames with one. Whenever a frame happened
to end that way, the next background clear silently no-opped — intermittent
flicker with no error anywhere.

```ts
// The COLOR clear honors colorMask too (#1043, the colour sibling of
// #780/#746): a frame whose last pipeline left an all-false writeMask
// (stencil-only clip / writeMask-0 pick) would silently no-op the next
// background clear → intermittent flicker. Unmask first (mirrors
// beginOffscreenPass :628). No restore: setPipeline re-sets colorMask.
gl.colorMask(true, true, true, true)
```

We had fixed the identical bug twice before — stencil masks (#746) and depth
masks (#780) — and the offscreen pass already unmasked colour. This was the
unfixed sibling in the family. The same sweep caught `dispatchComputeToR32UI`
leaking `gl.viewport` (now snapshot + restore in a `finally`) and the
no-depth `setPipeline` arm never disabling `POLYGON_OFFSET_FILL` (latent, not
yet user-visible). A fake-GL test now records the `colorMask` call order and
asserts the unmask precedes the clear — verified failing before the fix.

## How we verified four fixes without lying to ourselves

Every claim ran through directional pixel gates, never an absolute
difference percentage: before-vs-after diff strictly positive on the WebGL2
frame (something changed), WebGL2-vs-WebGPU distance strictly _decreased_ at
the identical camera (it changed toward the reference), and before-vs-after
on the WebGPU frame ≈ 0 (the reference didn't move). Then the diff image
itself, read as a 4×4 grid at full resolution plus a ×5 crop of the hottest
region — a downscaled glance is how the twin drifted this far unnoticed.

## The twin must die — and how to hold the seam until it does

Score: four user-visible defects, four root causes, all in hand-maintained
twin code, none in the shared engine. That tally is now the empirical spine
of #1046: eliminate the twin frame, and where behaviour must genuinely
differ, branch on **capability queries, not backend identity**. Backend
identity is how a WebGL2 `else`-branch accumulates a private physics — its
own anchor math, its own background policy, its own tessellation constant —
each divergence individually reasonable and collectively a second engine
that only your least-equipped users run.

But you cannot delete a twin the moment you convict it; #1046 is a program,
not a patch. What you can do immediately is what #1044 did: extract the
copied math into a single authority and pin the seam with a guard that
detects the _regression class_, not a proxy for it — the 20.7 km
camera-term witness instead of the 0.7 m full-sphere comparison that would
have blessed the bug. A twin you're stuck with is tolerable exactly in
proportion to how little of it is still a copy.

## References

1. ["Porting a WebGPU-first engine to WebGL2"](/blog/2026-07-07-porting-the-engine-to-webgl2) — the program index for the backend, and why neutrality was made structural where it could be.
2. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu) — the same silent WebGL2 auto-fallback, seen from the test suite's side.
3. ["Three render bugs reduced to one unsynced field"](/blog/2026-07-11-three-render-bugs-one-unsynced-field) — the reference-frame method (fix the frame you can trust, then diff against it) applied to a harness instead of a backend.
4. Session record: `docs/research/2026-07-13-globe-webgl2-bundle.md` — root causes, fixes, and the SwiftShader directional-diff method for all four defects (#1048).

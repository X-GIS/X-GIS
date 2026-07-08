---
title: "Pixels don't lie: debugging a dual-backend renderer"
description: "Three real bugs from making WebGL2 match WebGPU on a 117-layer basemap: a dedup map nobody cleared, a depth jitter that out-voted painter's order, and a vertically mirrored composite hidden by a symmetric test fixture."
date: 2026-07-07
tags: ['webgl2', 'debugging', 'testing', 'rendering']
lang: en
---

After every per-feature WebGL2 gate went green, the final exam was a real
style: OpenFreeMap Bright, 117 layers, Tokyo at z14, rendered by both
backends and pixel-diffed. Synthetic fixtures have three layers; real
basemaps have overlapping fills, stacked translucency, and label collision.
The first diff came back at 14.6%. Here is how it got to 6.8% (3.7% with
1-px AA tolerance), and what the three bugs taught us.

## First, fix the instrument

Rule one of pixel debugging: verify the capture before the renderer. Element
screenshots composite any DOM painted over the canvas — and our demo
harness's error overlay (triggered by a single boot `console.warn` on the
WebGL2 path) was sitting on the bottom-right corner, inflating one tile's
diff to 46%. The fix is `canvas.toBlob()`: canvas pixels only, no DOM,
ever. Every number in this post is measured on that capture.

Our diff is *directional* — content only in the reference renders red, only
in the candidate renders blue — and read as a 4×4 grid at full resolution,
worst tile first. Paired red/blue parallel edges mean positional shift;
one-sided red means width or presence; the color pattern names the bug class
before you open the code.

## Bug 1: every place name vanished

Point labels (city names, POIs) were missing on WebGL2 while road names and
shields rendered fine. The first guess was the obvious one — a whole layer
getting culled by a zoom or visibility gate on the GL path. Wrong: slice data
was byte-identical across backends and glyphs were rasterized. The tell that
killed the layer-gate theory: one POI layer dispatched 3 features instead of
143 — not a per-layer gate, a per-*feature* filter.

The culprit was a frame-scoped dedup map ("same resolved text near the same
anchor → drop") that the **WebGPU frame prelude clears every frame**. The
WebGL2 frame path early-returns *above* that prelude, so the map was never
cleared: frame 1 registered every name, and from frame 2 on every named
label was suppressed as its own duplicate. The 3 survivors had empty
resolved text — which bypasses dedup. Observation matched perfectly.

The anti-pattern, named so you can grep your own code for it: *shared
frame-scoped mutable state + a forked early-return path* that skips the reset.
When you fork a frame loop, enumerate everything the main prelude resets
before you branch above it.

## Bug 2: the park that lost a coin toss

Hibiya Park rendered green on WebGPU, background-cream on WebGL2. A missing
fill reads as geometry or blend state, so that's what we suspected first — a
dropped draw, or a wrong blend factor eating the layer. Chasing it took three
moves that walked away from both: exact pixel back-calculation (the WebGPU green was
`#d8e8c8` at full alpha — an *opaque* landcover fill, not the translucent
park layer), an isolation run (hide everything else → WebGL2 draws the same
green, so geometry and draw are fine), and a bisection (hiding every layer
*after* the grass didn't restore it — the occluder paints *earlier* in style
order). Something drawn earlier was beating something drawn later. That's
depth.

Two facts combined into the bug. Our fill fragment writes depth explicitly:
logarithmic depth plus a tiny per-feature jitter ($\pm1.5\times10^{-5}$,
there to break z-fighting on shared building walls) — which **overrides**
the per-layer vertex bias entirely, so all flat fills land at essentially
the same depth and the jitter decides ties. And on WebGPU this never
mattered, because the renderer substitutes a *ground* pipeline
(`depthCompare: 'always'`, no depth write) for every flat fill — pure
painter's order. The WebGL2 twin used the depth-testing variant. Result:
wherever the residential polygon's feature jitter happened to be smaller
than the grass polygon's, the later-drawn park lost the depth test and
vanished — an entire polygon erased because a per-feature hash was
unlucky. You will not find that bug by reading code.

So when you mirror a reference backend, the contract isn't just shaders and
blend state — it's the *pipeline substitution policy*: which depth and stencil
variant the reference actually selects, and when. That policy lives outside the
shared shader IR, which is exactly why identical shader math didn't save us.

## Bug 3: the upside-down composite

Buildings were ~2% darker on WebGL2; water was tinted. Hiding the
translucent bucket made both backends byte-identical, so the offscreen
MAX-blend + composite path was guilty. The bug was one constant: the
fullscreen composite triangle's UVs follow the WebGPU convention (v=0 at the
top row), but a GL FBO stores clip $y=-1$ at texture row 0. Sampling with
WGSL's constants composites the whole offscreen buffer **vertically
mirrored** — translucent stroke tint landing on the wrong half of the
frame.

The scary part: this had passed its dedicated parity gate, because the
fixture was a horizontal band centred on screen — *symmetric under the very
flip it should have caught*. One GL-only vertex function with flipped V
fixed it.

The takeaway is about fixtures, not compositing: a test fixture must be
asymmetric with respect to the transform you fear. Centered, mirrored, or
monochrome fixtures wave flips, mirrors, and channel swaps straight through.

## What's left in the 3.7%

Single-sample vs 4×MSAA edge speckle on dense building outlines, and one
inverted finding: the *reference* backend fails to draw dashed footpaths at
this zoom, which the WebGL2 twin renders — closer to MapLibre than the
authority it was mirroring. A diff never tells you which side is wrong;
it only refuses to let you look away.

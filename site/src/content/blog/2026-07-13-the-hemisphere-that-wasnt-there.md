---
title: "The hemisphere that wasn't there: computed, cached, uploaded, drawn nowhere"
description: 'Half the globe rendered as pure background, cut exactly at the 0-meridian z1 tile boundary. The fallback ancestors for the missing half were computed, CPU-cached, and force-uploaded to the GPU — then drawn nowhere, because a drape suppression flag was scoped to the renderer instance instead of one dispatch. Verified by making the network slow on purpose, after the first pixel readback lied.'
date: 2026-07-13T22:00:00Z
tags: ['rendering', 'debugging', 'state-management', 'verification']
lang: en
draft: false
---

The probe capture for #1076 shows a planet cut in half: the east hemisphere
fully rendered, the west pure background colour, and the boundary not
anywhere interesting — exactly the 0-meridian, which at z1 is a tile column
edge. That edge is the tell. A projection or culling bug curves; a
data-availability bug follows tile boundaries. The west half's tiles were
still streaming, and the engine was drawing _nothing_ in their place.

Which should have been impossible, because standing in for missing tiles is
a machinery we've invested in deliberately: a pinned low-zoom skeleton
guarantees `classifyFallback`'s ancestor walk always finds a cached tile
(before it, fast-pan cleared the canvas to white); the walk computes
`fallbackKeys` per frame; the coarse parents were CPU-cached and
force-uploaded to the GPU. Every stage upstream of the draw call did its
job. The draw call never happened.

## The narrowing observation

The raster basemap path never shows this bug. Its fallback is embarrassingly
self-contained — inside its own draw loop, per missing tile, it just walks
up:

```ts
// Parent fallback: walk up until we find a cached tile
```

and renders whatever ancestor it finds (`raster-renderer.ts:578-608`). No
other subsystem can interfere, because nothing else participates.

The vector globe path broke only under a specific configuration: WebGPU,
non-extruded layers, constant fill, no pattern — which sounds narrow until
you notice it is the **default land/water case**, the configuration every
plain basemap runs. That configuration is exactly when the #599 _drape_ is
active: instead of drawing each tile's fill as direct ECEF chord geometry
(a triangle spanning a big arc projects as a chord and cuts through the
sphere), the drape bakes resident tiles' fills into textures and drapes them
onto the curved sphere grid. And with the drape off, fallback worked fine —
coarse chords are the accepted globe behaviour there.

So: fallback fine without the feature, gone with it. The bug lives in the
interaction.

## Two flags with the wrong lifetime

When the drape owns a frame's tiles, the renderer suppresses the direct
chord draw so tiles don't render twice:

```ts
const drawFills = phase !== 'strokes' && !this._drapeGlobeFills
```

`_drapeGlobeFills` and `_drapeStrokes` are **instance fields**, set once per
`render()` when the drape takes over. But `renderTileKeys` — the dispatch
that reads them — is shared by _two_ callers: the primary draw of the
needed tiles, and the fallback draw of the ancestors. The drape's
`renderGlobeFills` only ever receives `neededKeys`; nobody ever hands it
`fallbackKeys`. So the flags said "the drape has this covered" to a dispatch
whose tiles the drape has never seen. The primary suppression was correct;
the fallback inherited it and silently dropped every ancestor draw.

Computed, classified, cached, uploaded — and suppressed at the very last
hop, by a flag scoped to the renderer instead of to the one dispatch whose
double-draw it prevents.

## The fix is a scope, not a feature

```ts
const _fbSavedDrapeGlobeFills = this._drapeGlobeFills
const _fbSavedDrapeStrokes = this._drapeStrokes
this._drapeGlobeFills = false
this._drapeStrokes = false
try {
  // … fallback dispatch: bundle-record arm + direct arm …
} finally {
  this._drapeGlobeFills = _fbSavedDrapeGlobeFills
  this._drapeStrokes = _fbSavedDrapeStrokes
}
```

One subtlety earns the `try` its width: the fallback path can render through
a cached render bundle, and the bundle is _encoded synchronously inside the
try_ — so the recorded bundle bakes the un-suppressed draws in. Had the
encode been deferred past the `finally`, the bundle would have recorded
suppressed (empty) draws once and replayed the blank hemisphere from cache
indefinitely. And no double-draw is possible: fallback chords are clipped by
`clip_bounds` to the missing-child areas, which are disjoint from the tiles
the drape baked.

Primary suppression is untouched. The regression test makes that literal: it
is a source gate pinning the dispatch region's text — the clear precedes the
first `renderTileKeys`, the restore lives in a `finally` after the last one,
and there is **exactly one** `this._drapeGlobeFills = false` in the file, so
the primary path can never quietly gain a second. (Why a source gate: the
flag is a private field read deep inside `render()`, behind source, bind
groups, tile decisions, drape, and bundle cache; faking that whole pipeline
to test one boolean is a bigger lie than reading the source. Fail-before
verified against the stashed pre-fix file: 3 of 4 assertions fail on it.)

## Verifying a bug that needs a slow network

Here the interesting part of the session started: on a fast connection the
bug is invisible, because the west tiles land before you can screenshot the
gap. To verify the fix we had to _manufacture_ the failure — a Playwright
route handler holding every z1–z3 west-column tile request for 20 seconds
while the east column streamed normally. Before the fix: the probe's blank
west hemisphere, on demand, for 20 s. After: coarse z1 parents render
immediately as chords, and refine as the delayed tiles arrive.

The verification nearly reported the fix broken anyway. The first readback
drew the canvas into a 2D context and read pixels — zeros. All zeros. On a
WebGPU canvas under Chromium, `drawImage`/`getImageData` readback yields
transparent pixels; our own e2e helpers carry the warning
("`page.screenshot()` captures the rendered canvas correctly … reading back
via Canvas2D drawImage on a WebGPU canvas yields transparent pixels"). The
compositor screenshot is the ground truth; the in-page readback is not.
Had we trusted the readback, we'd have concluded the hemisphere was still
missing and un-fixed a correct fix.

## What generalizes

A fallback that routes through another subsystem's dispatch inherits every
flag that subsystem will ever grow. The raster path has never had this bug
and never will — its fallback never leaves home. The vector path's fallback
was born correct and _lost_ correctness when an unrelated feature (the
drape) added a suppression flag whose lifetime — the whole render — was
wider than the decision it encoded, which was about the primary tiles only.
State scoped wider than its decision is a bomb a later feature arms.

And availability code has a special verification burden: it only executes
when something is missing, so a green run on a healthy network verifies
nothing. You have to break the network on purpose — and then make sure the
instrument watching the screen isn't the thing that's actually broken.

Proper drape-native fallback (baking the parent into the drape with UV
windowing, so ancestors get the curved treatment too) remains open as a
#599 follow-up; today's coarse chords beat a blank hemisphere.

## References

1. ["The unused binding that dropped the draw"](/blog/2026-07-08-the-unused-binding-that-dropped-the-draw) — another draw that silently never happened, for a very different reason.
2. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu) — the companion readback lesson: pin _which_ system produced the pixels you're judging.
3. ["The map that downloaded the world"](/blog/2026-07-13-the-map-that-downloaded-the-world) — the same skeleton machinery, seen from the cost side: what "always have an ancestor cached" was spending to be true.

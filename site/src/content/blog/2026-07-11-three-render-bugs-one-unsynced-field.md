---
title: 'Three render bugs reduced to one unsynced field in the test harness'
description: 'A missing hemisphere, labels floating off the globe, and tile seams at z6.73 were filed as three engine bugs. All three were one unsynced camera field in the demo harness — and after the fix, review found the identical write one harness file over.'
date: '2026-07-11T13:00:00Z'
tags: ['debugging', 'test-harness', 'root-cause']
lang: en
draft: false
---

A URL hash pinned a 3D globe at latitude 55.643°N. On unmodified main, after
the map settled, the live camera read back `centerLatDeg = 0`: the globe was
rendering the equator. Nobody had filed that bug. What had been filed were
three separate render bugs, each apparently living in a different engine
subsystem — only a hemisphere rendering near the antimeridian, at longitude
177.84 (#799); labels drawn off the globe (#800); and tile seams recurring
at zoom 6.73 (#803).

All three reduced to one missing method call — not in the engine, in the
demo harness that every one of the three repro links ran through.

## The wrong first move

The reports named engine subsystems, so that is where the investigation
pointed first: a missing hemisphere reads as a culling or tile-selection bug,
recurring seams read as a tile-pipeline regression. Both leads dissolved on
contact with the evidence.

For #799, the literal symptom did not reproduce: at the issue's pinned hash
the globe disc rendered _full_, buggy build and fixed build alike —
far-hemisphere tile selection appears to have been repaired by earlier work
already on main. Whatever the reporter saw, the engine defect that would
explain it no longer existed.

For #803, the premise was false. The report claimed the seams had been
"closed via RTT raster-drape" and had now regressed. Git said otherwise: the
raster-drape was a proof-of-concept that never landed on main — a still-open
issue says exactly that ("drape not wired on main") — and the earlier
faceting bug had actually been closed by great-circle tessellation. You
cannot regress a fix that never shipped. And the symptom at that hash today
was not seams: it was a blank frame.

Two of the three reports had failed fact-check. What survived was their
repro data: each issue pinned an exact camera hash.

## What actually happened

The remaining common denominator was the repro path: all three bugs were
reproduced by loading a camera hash in the playground demo page. So instead
of asking the renderer what was wrong, we asked the camera what it believed —
at each pinned hash, on unmodified main, on a real GPU:

| Issue | hash asked for lat | camera `centerLatDeg` | filed as               |
| ----- | ------------------ | --------------------- | ---------------------- |
| #799  | 15.126             | **0**                 | hemisphere missing     |
| #800  | 55.643             | **0**                 | labels off the globe   |
| #803  | 48.426             | **−3.18**             | seams / blank at z6.73 |

The camera stores its center twice: `centerY`, in Mercator meters — the flat
projection's authority — and `centerLatDeg`, the true latitude in degrees,
which exists because Mercator Y saturates at ±85.051129° and a sphere camera
must be able to go pole-ward of that. The 3D globe renders from
`centerLatDeg` and selects tiles from it. The pair is kept consistent by a
contract: after any direct `centerY` write, call the camera's public
`syncCenterLat()` hook, whose doc comment says it exists precisely for
"centerY writers outside the Camera class." Every writer inside the library
honors it — the gesture controller's pan/zoom fast paths, three
source-manager sites, the prefetch scheduler — and the public API
(`setCenter`, `jumpTo`) never exposes the problem at all. The only writers
that skipped it were in the harness. The hash-camera writer, pre-fix,
verbatim:

```ts
cam.centerX = h.lon * RAD * R_EARTH
const clampLat = Math.max(-85.051129, Math.min(85.051129, h.lat))
cam.centerY = Math.log(Math.tan(Math.PI / 4 + (clampLat * RAD) / 2)) * R_EARTH
cam.bearing = h.bearing
cam.pitch = h.pitch
```

`centerY` updated, `centerLatDeg` stale. Every globe view loaded from a URL
hash — which is how all three bugs were reproduced — rendered from whatever
latitude the camera happened to hold before the hash was applied. From
there, the three "different" bugs are one wrong number wearing three
costumes: at hash lat 55.6 the disc sat at the equator, so the northern
labels projected past its edge (#800); at hash lat 48.4 the intended
Mongolia land view collapsed to mid-ocean and drew a blank frame (#803); at
hash lat 15.1 the view was simply the lat-0 view, read as "wrong/half"
(#799).

Engine bugs found: zero. The library rendered exactly what it was told by a
desynced camera.

## The fix

```ts
cam.centerY = Math.log(Math.tan(Math.PI / 4 + (clampLat * RAD) / 2)) * R_EARTH
// The globe/sphere family renders (and selects tiles) from the TRUE centre
// latitude camera.centerLatDeg, which a direct centerY write leaves STALE.
// Without this resync a hash camera silently drove the globe at lat≈0 —
// wrong hemisphere / labels off the disc / a blank land view (#799/#800/#803).
// This honours the SAME contract the library's own external centerY writers
// (CameraController pan/zoom, SourceManager) already follow; flat projections
// ignore centerLatDeg, so it is inert off the globe.
cam.syncCenterLat()
```

The same call went into the harness's style-root camera writer, the second
place it poked `centerY` directly. Real-GPU before/after pixel diffs
measured what one line bought: 23.7% of pixels changed for #799, 32.2% for
#800, and 100% for #803 — blank frame to full continents, with a 4×4
full-resolution split showing continuous country fills and no tile seams.

## The fix for the fix

The PR shipped with an honest scope note: three _other_ harness files also
write `centerY` directly, "left unchanged — flat-oriented / debug tools, not
exercised by these issues."

The review panel refuted the categorization. The compare runner — the
side-by-side MapLibre↔engine parity harness — contained the identical
unsynced write, and it is not flat-oriented: it parses a `?proj=` URL
parameter, sets globe projection on _both_ panes, and re-applies the camera
view _after_ `setProjection`, making the desynced write the last camera
write before render; its MapLibre→engine sync handler then re-runs the write
on every MapLibre-driven move. Had it stayed, the A/B harness would compare
two different places on Earth — reference map at the requested latitude,
engine at roughly zero — poisoning the pixel-diff verification used to sign
off globe work. (Proven mechanistically from the code; we did not drive a
live A/B render, which needs network tiles.) One more `cam.syncCenterLat()`
landed in a follow-up commit; the two genuinely debug-only save/restore
writers still carry the pattern and were flagged for follow-up.

The sting is the timing: the scope note excluding that file was written by
the same author who had root-caused the desync minutes earlier. A consistency
rule that lives in a comment fails even in the hands of the person who just
learned why it matters.

## How we know it holds

The invariant went into a CI regression gate rather than a comment: load
each issue's pinned hash on the globe, then assert that
`camera.centerLatDeg` matches the hash latitude within 0.5° — a
deterministic, non-raster camera-state check that runs GPU-less under
headless SwiftShader. On unmodified main it fails exactly as the mechanism
predicts:

```
[globe-hash #799] centerLatDeg=-3.1774 (want 15.12559)  Received: 18.303 (< 0.5 expected)
[globe-hash #800] centerLatDeg=-3.1774 (want 55.64329)  Received: 58.821
[globe-hash #803] centerLatDeg=-3.1774 (want 48.42584)  Received: 51.603
3 failed
```

All three read the same stale −3.1774° — whatever the last synced writer
left behind; we never pinned down which write produced it (headed runs
against a different demo style had measured 0/0/−3.18). With the fix, all
three read back the hash latitude — 15.1256 / 55.6433 / 48.4258 — and the
#803 case that had rendered blank measures `land=172972/619200` (27.9%).

Two caveats, both real. The fix and the gate landed in one commit, so there
is no commit-order proof of the red run; the review accepted it because the
three failure deltas equal |−3.1774 − lat| exactly and no code path can
self-heal the stale value (the render loop's only `syncCenterLat` call sits
in a non-finite defense branch). And the #803 raster assertion under a
software GPU is deliberately coarse — a >5% land-coverage floor, not pixel
parity. The gate has since run green in actual CI: all three cases passing,
land coverage 168007/619200 (27.1%).

## What generalizes

First, value inside a bug report is unevenly distributed: the diagnosis and
even the premise can be wrong — one of these claimed a regression of a fix
that never shipped, another described a symptom that no longer reproduced —
while the repro data is gold. Three reports named three subsystems, but
their repro links shared one path; auditing what the repros had _in common_
found what auditing the named subsystems could not, because the harness fed
every subsystem the same lie. When a harness writes engine state directly,
N of its bugs get filed as N engine bugs, and the engine is innocent each
time.

Second, a two-field consistency maintained by "remember to call sync after
writing" is not a contract, it is a bet — lost twice in this one story, the
second time in the scope note of the very fix, by the author freshest on the
pattern. The fix raised the convention's call-site count to eight-plus; the
durable end state is deleting the convention in favor of one setter that
syncs internally. Until then, the gate holds the line the comment cannot.

## References

1. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu) — same session, the other way a harness lies: output assertions that never pin which system produced the output.
2. ["What a software GPU can verify"](/blog/2026-07-07-what-a-software-gpu-can-verify) — why the CI gate asserts a camera-state invariant plus a coarse coverage floor instead of pixel parity under SwiftShader.

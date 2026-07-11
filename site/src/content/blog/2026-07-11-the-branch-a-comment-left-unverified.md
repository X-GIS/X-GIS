---
title: 'The branch a comment left UNVERIFIED diverged 6×'
description: "A single-authority migration for on-screen scale left the globe branch returning the raw, uncapped value under a comment reading 'UNVERIFIED'. A sibling branch of identical shape was a non-bug — and only a probe of which value is read told them apart."
date: 2026-07-11T04:40:00Z
tags: ['rendering', 'verification', 'numerical']
lang: en
draft: false
---

There is one authority for "how many metres does a screen pixel cover right now,"
and every size that has to track the view — line width, label spacing, heatmap
radius — is supposed to read it. The migration that created it left one branch
behind, in plain sight, under a comment that all but dared you to look:

```ts
effectiveMpp(projType, canvasHeight, dpr = 1) {
  const rawMpp = WORLD_MERC / TILE_PX / Math.pow(2, this.zoom)
  if (this.globeMode || isGlobeProj(projType)) return rawMpp // ← #739 scopes this out (UNVERIFIED)
  const cap = flatViewHeightCapM(projType, WORLD_MERC)
  return Math.min(rawMpp, cap / (canvasHeight / dpr))
}
```

The flat branch caps `rawMpp`; the globe branch returns it raw. On a tall canvas at
low zoom the globe's actual frame does _not_ scale with `rawMpp` — its matrix builder
saturates the view height at `min(WORLD_MERC·cosLat, 2·EARTH_R)`, freezing the
on-screen scale below a threshold zoom while `rawMpp` keeps halving with every zoom
step. So a size consumer reading this authority on the globe scales the world by a
number the frozen frame stopped rendering at. That is a real divergence — the same
class as the line-width bug this whole authority was built to kill.

Except the word in the comment is _UNVERIFIED_, and that word is doing more work than
it looks.

## The wrong first move

The tempting read is to trust the comment as a verdict. Two ways to trust it, both
wrong. One: "a previous author looked and scoped it out, so it's fine" — add the cap
would then be gratuitous. Two: "it says UNVERIFIED, so it's a known bug — just add the
cap." Either way you skip the one step the comment is explicitly telling you it
skipped: checking whether the raw value is actually _read_ at a scale that renders.

The reason you cannot skip it is sitting one branch over. In the very same migration,
a sibling consumer — the heatmap frame uniform — packed the identical raw,
uncapped metres-per-pixel, and _that_ was a non-bug. The shader declared the lane and
then read it nowhere; the value was write-only, so its wrongness was unobservable. On
paper the two cases are indistinguishable: "this branch returns the raw uncapped mpp."
One is a live divergence, the other is dead code. The static description that fits
both is the description that tells you nothing.

## What actually happened

So probe it, and probe the _frame_, not the formula. Take a tall canvas (H = 2048),
put the camera in the sub-cap band, and measure what the ECEF matrix actually renders:
project a real 1000 m north offset through the true MVP, read back its NDC height,
and recover the view height in metres. Do it at two zooms one half-step apart:

```
z = 1.0 : frame on-screen scale = 6228.65 m/px   rawMpp = 39135.76 m/px   ratio 6.28
z = 1.5 : frame on-screen scale = 6228.65 m/px   rawMpp = 27673.16 m/px   ratio 4.44
```

The frame scale is _frozen_ — identical at both zooms, exactly `2·EARTH_R / H` — while
`rawMpp` halves. The authority and the frame disagree by more than 6×, and they
disagree _differently_ at each zoom, which is the signature of a size that drifts as
you zoom while the picture holds still. The divergence is not only real, it is
reachable at ordinary low-zoom globe views. The comment's `UNVERIFIED` was not a
verdict; it was an open question, and the answer was yes.

## The fix

Cap the globe branch too — but derive the cap from the _same_ source the matrix
builder uses, re-expressed in the mpp basis the consumers expect, so there is no
second formula to drift:

```ts
if (this.globeMode || isGlobeProj(projType)) {
  const cosLat = Math.cos(mercatorYToLatRad(this.centerY))
  const capMerc = Math.min(WORLD_MERC * cosLat, 2 * EARTH_R) / cosLat
  return Math.min(rawMpp, capMerc / (canvasHeight / dpr))
}
```

Above the threshold zoom `Math.min` selects `rawMpp` and the return is byte-identical
to before; below it, the return is the frozen frame scale the probe measured. The
`Math.min(rawMpp, cap/H)` shape mirrors the flat branch deliberately — the algebraically
tidier `viewHeightTrueM / (H·cosLat)` would lose byte-identity above the threshold to
float re-association, and byte-identity in the normal zoom band is what makes this
safe to land under a heavily-tuned renderer.

## How we know it holds

The gate measures the frame independently of the fix. The witness projects an ENU
offset through the real `buildECEFFrameView` MVP and recovers the height from NDC — it
observes what the frame renders, not a re-run of the cap arithmetic, so a copy-paste
error in the fix cannot make the test pass by agreeing with itself. Three assertions:
the capped return lands on the frozen frame scale at two sub-cap zooms for latitudes 0
and 45 (exercising the `cosLat` path); it is `toBe`-identical to `rawMpp` at z10/14/20
across latitudes 0/45/70 (no regression in the normal band); and reverting the branch
to `return rawMpp` fails the first assertion with the 6× ratio the probe found. The
full camera suite stays green, so the flat branch is untouched. What remains
GPU-pending is the on-screen pixel size of the downstream consumers; only the numeric
contract of the authority is pinned here.

## What generalizes

A comment that says `UNVERIFIED` is not information about the code; it is a note that
verification didn't happen, and it ages into whatever the reader wants it to mean. The
useful response is neither to trust it nor to act on it, but to run the check it names
— because the shape "this branch returns the raw value" is shared by a live bug and by
dead code, and no amount of reading the return statement separates them. The
separation is empirical: is the value _read_, and at a scale that _renders_? A single
authority earns its name only when every branch is checked against the thing it claims
to describe; the branch nobody probed is exactly where the authority quietly stops
being one.

## References

1. [When the bug is already fixed, the test still isn't](/blog/2026-07-10-when-the-bug-is-already-fixed) — the sibling case in the same migration, where the identically-shaped "returns raw uncapped mpp" was a write-only lane and the predicted drift could not occur. This post is its confirmed twin: same shape, opposite verdict, told apart only by a probe.

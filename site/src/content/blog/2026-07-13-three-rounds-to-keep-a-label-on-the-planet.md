---
title: 'Three rounds to keep a label on the planet'
description: "A row of country labels floated in the sky above the globe's horizon. Round 1 — an angular margin, provably safe at every zoom — died because floaters and healthy labels interleave in angular depth (Nigeria 0.332 floats, Kenya 0.329 doesn't). Round 2's screen-space limb fixed Chad and missed two-line Burkina Faso by exactly one line of text. The gate only held once it moved to where the quad height actually exists."
date: 2026-07-13T21:00:00Z
tags: ['labels', 'rendering', 'debugging', 'verification']
lang: en
draft: false
---

At globe zoom 2, latitude 20, pitch 85°, a row of country labels renders in
the sky — glyph quads floating cleanly past the planet's silhouette, on both
backends, pixel-identical. The issue (#1042) guessed the cause: "missing
far-side containment." That premise died first: the label projector already
culls with the exact tangent-cone test, the same formula the tile selector
uses. The cull was correct. It was also _binary_: an anchor one pixel inside
the limb passes, and its quad — tens of pixels of text centred on that
anchor — draws the rest of itself into space.

So the fix is "require some headroom inside the horizon." Three rounds of
that, and the instructive part is that every round's unit tests were green
while a screenshot refuted the round. Twice.

## Round 1: the margin that was provably safe — for the wrong variable

The obvious margin is angular: don't just require the anchor inside the
tangent circle (`cos ≥ cosH`), require it a band inside. The trap I did
manage to dodge is the _additive_ margin. The globe path runs at city zoom
too, where the visibility headroom `1 − cosH` collapses — measured 0.0027 at
z12 and 4·10⁻⁵ at z18 — so any fixed cosine offset eventually exceeds the
entire headroom and blanks every label on screen, including one at dead
centre. The margin therefore had to be a _fraction_ of the headroom:

```ts
const cosC = cosH + LABEL_HORIZON_MARGIN * (1 - cosH) // 0.15 of the headroom
```

A fraction strictly below 1 can never cull the sub-eye point, at any zoom —
we pinned that with a z12 regression test, matched the 0.15 to an existing
flat-path precedent, and measured the calibration at the worst camera
(z0, pitch 85: trims a 7.9° angular rim for under a pixel of radial screen
cost). Mathematically safe for every zoom. Shipped.

The probe screenshot refuted it in one frame. At the probe camera the gate's
own metric refuses to order the labels: Nigeria sits at headroom fraction
f = 0.332 and floats; Kenya sits at f = 0.329 and is perfectly healthy. In
angular terms, Chad floats 7.5° _inside_ the horizon while Kenya is fine at
14.8° inside. Floaters and healthy labels **interleave in angular depth**,
because screen compression at the limb varies with azimuth — the same
angular band is sub-pixel at one bearing and half a text line at another.
There is no threshold to tune. The proof of safety quantified over zoom;
the bug lived on the azimuth axis.

## Round 2: measure in the space where the failure is

The failure is "pixels above a screen-space curve," so round 2 gates in
screen space: project the horizon circle itself — centre `e·R·cosH`, radius
`R·sinH`, plane perpendicular to the eye axis, the same sphere model the
anchor cull uses — into a 64-sample screen polygon, and draw an anchor only
if its already-computed screen point sits at least 7 px inside that limb
polygon. The one design decision that mattered: the circle is projected
through the **identical** rtc-matrix+focus path the anchors themselves take.
No second projection theory, no frame-consistency bug waiting; if the
anchors move, the limb moves with them, by construction.

Why 7 px: the quad is centred on its anchor, so only the top half rises
toward the sky, and half of our ~14 px line height is 7. The probe's own
witnesses bracket the constant into (2.9, 11.8]: floating Chad projects
2.9 px inside the limb (must be culled), healthy Kenya 11.8 px inside (must
survive). Chad's label left the sky. Green tests, better screenshot.

Then the screenshot pushed back twice more.

First, it accused the wrong country. Reviewing the after-frame downscaled to
fit, I flagged Nigeria as still floating. Its measured inset said 11.7 px —
statistically indistinguishable from healthy Kenya's 11.8 — and the ×5
native-resolution crop showed the label sitting flat on the disc. At review
scale, a healthy label and a floater are the same three grey pixels; the
downscaled read was noise. (Our own verification rules ban exactly this
judgment, and I made it anyway, in the session that was busy proving why
the rule exists.)

Second, the same ×5 crop pass found the real survivor: **Burkina Faso**,
a two-line label, top line fully in the sky. Its anchor sits 7.92 px inside
the limb — past the 7 px gate, so round 2 keeps it — but a two-line quad's
half-height is ~12 px. The constant encoded "labels are one line tall." The
fix missed by exactly one line of text.

## Round 3: move the gate to where the height exists

The honest conclusion: the label pass _cannot_ know the quad height at its
dispatch site, because the text hasn't been shaped yet. Any constant there
is a guess about typography. The quad height has exactly one authority — the
collision box built in `text-stage.prepare()`, the same bbox the greedy
placement collides and the renderer consumes — so that is where the gate
went. The projector now exposes the measurement, not the decision:

```ts
/** px the screen point sits inside the projected limb polygon;
 *  +Infinity off-globe / flat / degenerate cameras. */
limbInsetPx: (x: number, y: number) => number
```

and the collision-box build makes the call: a point label whose box centre
sits closer to the limb than its half-height (+2 px) emits no collision
candidates at all. Greedy placement never sees it, so it stays unplaced —
which holds under `allowOverlap` too, since empty bboxes never enter the
loop — and its paired icon drops in lockstep instead of orphaning.

The witnesses, pinned at the probe camera: Burkina Faso (−1.6, 12.4), inset
7.92 px — skipped at any line count. Kenya (37.9, 0.2), inset 11.57 px —
kept as a single line, and correctly skipped if you set it in three lines
(half-height ~21 px > 11.57). The gate finally scales with the thing that
was actually poking into the sky.

## How we know it holds

Each round left behind the test that would have caught it. Round 1's
additive-margin trap is pinned by the z12 test (headroom 0.0027 < 0.15, yet
the dead-centre anchor survives). Round 2's limb cull is fail-before
verified — neutering the limb test fails exactly the Chad-cull assertion —
and `map.project()` is pinned byte-identical, because the public "where does
this coordinate land" API must never inherit a label-policy cull. Round 3
pins the BF/Kenya insets to within half a pixel and the skip arithmetic on
both sides.

But keep the score honest: the unit suite was green at the end of round 1
and round 2. Tests encode the round's own theory of the bug; they are how a
fix stays fixed, not how it gets refuted. All three refutations came from a
rendered frame — one full-resolution 16-split and a ×5 crop each time.

## What generalizes

A gate can be provably safe across its entire domain and still wrong,
when the proof quantifies over one axis (zoom) and the failure varies along
another (azimuth). The Nigeria/Kenya pair — 0.332 floats, 0.329 doesn't —
is what that looks like in data: when your gate's own metric interleaves
positives and negatives, stop tuning the threshold; you are measuring in
the wrong space.

And when the right space still fails, ask _whose_ number the gate is
guessing. Round 2's 7 px was the label pass re-deriving a quantity —
quad height — that another stage owns outright. Moving the check to the
authority didn't just fix two-line labels; it deleted the assumption class.
The constant knew about fonts. The collision box just knows the height.

## References

1. ["The label that lands in the ocean"](/blog/2026-07-11-the-label-that-lands-in-the-ocean) — the previous label-anchor bug, and the same lesson about points that are _usually_ inside.
2. ["Three render bugs reduced to one unsynced field"](/blog/2026-07-11-three-render-bugs-one-unsynced-field) — an earlier #1042-adjacent report ("labels off the globe") that turned out to be the harness, not the engine.
3. ["Pixels don't lie"](/blog/2026-07-07-pixels-dont-lie) — why the rendered frame outranks a green suite in this codebase's verification order.

---
title: 'The migration regressed one renderer at a time'
description: 'A coordinate-space migration carried one assumption — "absolute geometry needs no per-copy shift" — that was true for the globe and false for flat maps. Applied per-renderer, it silently dropped world-copy fan-out path by path. The fix is one ten-line router.'
date: 2026-07-11T01:10:00Z
tags: ['architecture', 'refactoring', 'rendering']
lang: en
draft: false
---

This loop runs once. It is still written as a loop, and it sits under a
comment explaining why running once is correct:

```ts
// PR 2d.1D: graticule vertices are absolute ECEF — no per-copy camera
// shift needed. Draw once per frame (ECEF world-copy = same geometry).
// Previously iterated worldCopiesFor(projType) for Mercator cam_h shift.
for (let wi = 0; wi < 1; wi++) {
```

The comment was true on the globe and false on a flat map. At low zoom, a
flat Mercator view shows the world several times side by side; each repeat is
realized by a per-copy metre offset at draw time. When the engine migrated to
absolute-ECEF vertices, the migration's core assumption — "absolute geometry
needs no per-copy shift" — held for the globe (one world, by definition) and
not for flat display. The graticule kept the shape of the old fan-out loop,
capped at one iteration, while the polygon-fill renderer next door kept its
real loop. Result: at low zoom, fills repeated across world copies and the
grid lines drawn over them appeared only in the primary world.

The interesting part is not the bug; it's the distribution of the bug. The
same migration left fills, inline points, and tile point-labels correct, and
broke the graticule, the tile point renderer (`const COPIES = [0]`), and tile
line-labels (a single unlooped projection call) — each in its own file, each
with its own author-moment of "ECEF is absolute, so one pass is fine."
A cross-cutting decision — _which world copies are visible this frame_ — was
being re-derived locally by every renderer, so a migration that changed the
answer could only regress it renderer by renderer, wherever the local
re-derivation happened to be rewritten.

## The wrong first move

The tempting fix is to write the world-copy formula into a shared helper —
compute visible copies from the camera frustum, longitude span, projection
periodicity. That would have been a fourth implementation. Three correct
copy computations already existed: the Mercator frustum-based enumeration,
the periodic-projection table, and the globe's trivial `[0]`. The bug was
never that a formula was missing; it was that _choosing between them_ was
distributed. Centralizing by re-deriving would have added a new divergence
candidate with its own edge cases.

## The fix

The authority is a router, not a formula — ten lines that only choose:

```ts
export function visibleWorldCopiesFor(
  projType: number,
  host: VisibleWorldCopiesHost,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): readonly number[] {
  if (host.globeMode || isGlobeProj(projType)) return SINGLE_COPY
  if (isMercatorProj(projType)) return host.getVisibleWorldCopies(canvasWidth, canvasHeight, dpr)
  return enumerateWorldCopies(projType, host.zoom) ? worldCopiesFor(projType) : SINGLE_COPY
}
```

The graticule now iterates what the router returns, applying the same
per-copy offset the fill path applies, and keeps the single-pass ECEF fast
path only where the router says one copy exists. The migration's assumption
finally lives in exactly one `if`.

## How we know it holds

The consumer-wiring gate drives the renderer with a flat-Mercator camera
where the router reports four visible copies and asserts one draw per copy
with the per-copy offset in the uniforms. Reverting only the renderer change
fails it with `expected 1 to be 4` — the pre-fix loop draws once regardless —
while the globe test (single ECEF pass, flat MVP never consulted) stays
green, so the gate discriminates the two regimes rather than counting draws.
What a unit test cannot vouch for is the final pixels — the repository's own
render bar demands a real-GPU pass before the issue closes, and that is
recorded as pending, not claimed.

## What generalizes

A migration is an assumption applied everywhere; if the assumption is
re-stated locally in each consumer, "everywhere" arrives one file at a time
and so do the regressions. The two tells were both in that one deleted
snippet: a loop whose bound is a constant `1` (shape preserved, semantics
capped — someone hedged), and a comment asserting a cross-cutting invariant
from inside a single consumer. A comment is where an invariant goes to rot;
a router the consumers must call is where it stays true — and when you do
centralize, route to the existing per-case computations rather than
re-deriving them, or the authority becomes the newest fork.

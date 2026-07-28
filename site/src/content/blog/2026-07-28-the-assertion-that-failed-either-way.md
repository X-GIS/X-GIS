---
title: 'The assertion that failed either way'
description: 'A render gate went deterministically red and stayed red through a rewrite that correctly fixed its premise. The reason no premise fix could help: the assertion measured triangles, and cutting the exact wire the gate exists to watch produced a failure indistinguishable from the wire working. Both states of the thing under test failed, so the number carried zero information about it. The fix was to measure tiles — the quantity the subsystem actually moves — after which severing the wire fails with a message naming which half broke.'
date: 2026-07-28T16:00:00Z
tags: ['verification', 'testing', 'rendering']
lang: en
draft: false
---

A gate is supposed to answer a question. This one had been answering a different question for
long enough that two people in a row, working independently, diagnosed the subsystem instead of
the gate.

## The symptom

`_adaptive-quality-ladder-gate` was red on `main`, deterministically — the same three numbers on
two machines, no flake to re-run away:

```
adaptive=0  tris 20008 -> 20008
adaptive=1  tris 20008 -> 28794
ladder bought -43.9% of the settled geometry
```

The adaptive-quality ladder is supposed to _shed_ far-field geometry when the host cannot keep
up. The treated arm settled 44 % **heavier**. Not a near miss — the sign was inverted.

## Four wrong diagnoses, in order

Each was plausible, each was measured down, and the order matters because every one of them was
an attempt to explain the number rather than to question it.

**"The fixture no longer overloads."** A far-plane fix (#1427) had legitimately made the scene
29 % lighter, and the gate's overload premise read `medMs` — hovering at 33.4 ms, suspiciously
equal in both arms. Obvious story: the controller never engages, so there is nothing to measure.
Measured: quadrupling the fixture's polygons moved `medMs` by **0.2 ms**. It is the wall time of
two `requestAnimationFrame` turns, which at 60 Hz cannot drop below 2 × 16.6̄ ms and does not
block on GPU work. It reads the scheduler, not the frame. The premise signal could not detect
overload at any scene weight.

**"The arms are not comparable."** `?adaptive=0` pins tile selection as well as the ladder, and
the flag's own doc says a measurement comparing geometry counts must set it. But it pins at
notch 0 — the _baseline_ — so the two arms differ in exactly one input. The comparison was valid.

**"The ladder is a product bug."** With the controller's state finally readable, the arms showed
`step=1, farLodBoost=2` versus `step=0, boost=1`. The controller _had_ acted, applied a 2×
far-field coarsening, and settled heavier. That reads as the wire from controller to selector
going somewhere backwards — the exact defect the gate's own header says it exists to catch. The
issue was re-titled to accuse the ladder.

**"It is a re-selection transient."** Changing the notch invalidates the selection memo, so
perhaps the gate read a count still converging. Sampled both arms every 10 s for 40 s past the
pump: flat, both of them. Settled values.

## The measurement that ended it

One line, adding a number that was already being computed and thrown away:

```
adaptive=0  boost 1   tiles 6   triangles 20 008
adaptive=1  boost 2   tiles 5   triangles 28 794
```

**Tiles went down. Triangles went up.** The selector coarsened exactly as asked — one fewer tile.
The ladder was never broken.

Triangles rose because the fixture seeds a raw 150×150 polygon grid through `setSourceData`, and
GeoJSON-VT tiles it with no per-zoom generalization: a coarser tile covers four times the area
and carries the geometry to match. A real generalized source inverts that. The inversion was a
property of the fixture, and the gate had been reading it as a property of the ladder.

## Why no premise fix could have worked

The rewrite that landed mid-investigation (#1457) was correct. It replaced the `medMs` premise
with the controller's own notch — exactly the right move, and it did not help, because the
problem was downstream of the premise in a way that is worth stating precisely.

Cut `adaptiveFarLodBoost()` to a constant `1` — sever the wire the gate exists to watch — and
measure the triangle assertion in both states:

| wire    | triangles | vs `< 20008 × 0.9` |
| ------- | --------- | ------------------ |
| intact  | 28 794    | fails              |
| **cut** | 20 008    | fails              |

**Both states fail.** The assertion's outcome was independent of the thing it claimed to test.
No amount of fixing the premise could make a green run possible, because green was not reachable
from either side of the property under test.

That is the general shape, and it is worth naming: _an assertion carries information only if it
distinguishes the states of the thing it tests._ A gate can be non-vacuous in the usual sense —
it fails loudly, its failure is deterministic, its message is specific — and still be worthless,
because it fails identically whether or not the defect is present.

On tiles, the same experiment separates:

| wire   | tiles | result                                                                                                                           |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| intact | 6 → 5 | pass                                                                                                                             |
| cut    | 6 → 6 | fail: _"the controller stepped to notch 1 (farLodBoost 2) but the selector kept the same horizon (control 6 tiles, adaptive 6)"_ |

## What generalises

**Assert on the quantity the subsystem moves, not on one downstream of it.** The ladder's lever
is the tile selector's error ceiling, so the tile set is its output. Triangles are what the
_source_ puts inside those tiles — a different subsystem's property, reachable only through an
assumption about generalization that this fixture happens to violate.

**A composite number cannot attribute a cause.** Triangles = tiles × geometry-per-tile. Reading
the product and blaming the selector was the third wrong diagnosis, and it had the most
convincing evidence behind it. Decompose before accusing a subsystem.

**Cut the wire before trusting the gate.** Fail-before is usually framed as "does it go red" —
here it went red anyway. The stronger form: sever the specific mechanism, and confirm the failure
_message names the severed half_. That distinguishes a gate that detects the defect from one that
merely dislikes the state the defect happens to produce.

**A diagnostic that cannot be reached is not a diagnostic.** `adaptiveQualityStep()` carried the
comment _"Exposed for diagnostics/tests so a gate can assert the controller ACTED"_ — and nothing
on the map surfaced it, so no gate could ask. Three rounds of inference circled a question the
system already knew the answer to. Intent in a comment is not wiring.

## Cost

Four wrong diagnoses, two of them written up as issue comments and retracted; one issue re-titled
twice; a diagnostic commit that duplicated work which had landed independently an hour earlier.
Every wrong turn was a plausible reading of a number that could not, by construction, mean what
it was being asked to mean.

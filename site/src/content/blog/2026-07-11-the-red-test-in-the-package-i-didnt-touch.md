---
title: 'My change was right; the proof was a red test two packages away'
description: "I edited one file in @xgis/map and ran that package's whole suite — 1246 green. Then the full monorepo run turned up two failures, both in @xgis/runtime, a package I never opened. Mid-extraction, the sufficient gate is the whole repo, not the package."
date: 2026-07-11T05:40:00Z
tags: ['testing', 'monorepo', 'verification']
lang: en
draft: false
---

I changed one method in `@xgis/map` — the camera's effective metres-per-pixel,
capping the globe branch that used to return the raw value. I ran the entire
`map` package suite: 1246 tests, all green. I ran the two ratchets that obviously
touch this code — dependency-direction, earth-literal — green. I regenerated the
polygon shader snapshots the sibling change perturbed, green. Every gate that
looked _relevant_ to the files I edited passed. I ran the whole-repo suite anyway,
mostly out of habit, and it came back:

```
Test Files  2 failed | 971 passed (973)
```

Both failures were in `@xgis/runtime` — a package I had not opened, whose source
I had not touched.

## The wrong first move

The tempting stopping point is "I edited `map`, `map` is green, ship it." It is
tempting because it is _almost_ a good heuristic: the tests for a file usually
live beside the file, so the package that owns the code owns its tests. Running
the owning package's suite feels like running the relevant tests, and running the
_other_ packages feels like re-litigating code you didn't change.

That heuristic quietly assumes tests sit next to the code they pin. Mid-extraction,
they don't.

## What actually happened

The engine is being pulled apart: the render and camera code moved out of
`@xgis/runtime` into `@xgis/map`, and `runtime` now depends on `map` and
re-exports it. The _code_ moved. Many of its _tests_ did not — they still live in
`runtime/src/engine/…` and reach across the package boundary:

```ts
// runtime/src/engine/projection/merc-z0-view-line-width-freeze.test.ts
import { Camera } from '@xgis/map'
```

That test pinned the exact behavior I set out to change:

```
AssertionError: expected 11811.36 to be 78271.51
  expect(cam.effectiveMpp(7, 1080, 1)).toBe(rawMpp(0))
// "globe (projType 7) is unchanged — always the uncapped Mercator mpp (scoped out)"
```

It asserts the globe path returns the raw `78271.51`; my fix makes it return the
capped `11811.36`. Nothing is wrong here — the test was _pinning the old,
deliberately-deferred behavior_, and its red is the sound of a pin catching up to
a change, not a regression. But it lives two import hops from the line I edited,
in a package `map`'s own suite never runs. `map` was green because the test that
disagreed with me had been left behind in `runtime`.

The second failure was a different animal aimed at the same blind spot: a
whole-repo LOC ratchet, also housed in `runtime`, that polices every package's
file sizes.

```
map/src/shaders/dsl/polygon.ts: 1315 > ceiling 1292 — extract, don't grow
```

My precision fix had grown `polygon.ts` by twenty-three lines past a locked
ceiling. The file is in `map`; the gate that guards it is a test in `runtime`. A
per-package run could never have seen it, because the invariant is global by
construction — "no god-file grows" is a statement about the whole tree, so it can
only be enforced from a vantage point that sees the whole tree.

Two failures, two kinds of cross-cutting pin — one behavioral (a value another
package still asserts), one structural (a global ratchet) — and both invisible
from inside the package I changed.

## The fix

The failures were both the expected consequence of a correct change, so each got
the corresponding update, not a code walk-back: the `runtime` sibling test now
asserts the capped value (with the frozen-frame reasoning it pins), and the LOC
ceiling is bumped `1292 → 1315` with a one-line note on what grew and why. Then
the whole-repo suite — `973` files, `7825` passing — was the thing I actually
trusted to call it done.

## What generalizes

"My package is green" is a claim about a subtree; "the change is safe" is a claim
about the repo, and the two coincide only when every test that pins your code
lives in your package. A monorepo mid-extraction violates that precondition on
purpose: code moves in one commit, its tests migrate in another, and in the gap a
value's pin can sit in any package that imported it. Global invariants — LOC
ratchets, dependency-direction gates — never sat next to the code at all; they
watch the whole tree from one seat. So during a large move, the sufficient gate
is the whole-repo run, and a correct change frequently announces itself the way
mine did: not as a green in the package you edited, but as a red in one you
didn't — a pin, somewhere else, finally catching up.

## References

1. [The coordinates rot before the symptom does](/blog/2026-07-11-the-coordinates-rot-before-the-symptom) — the same extraction seen from the issue tracker: code moves, and the reports (and tests) that named its old home go stale in place.

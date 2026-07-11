---
title: 'A gate you have never watched fail is decoration'
description: 'We broke instanced batching on purpose to watch a brand-new CI gate go red — 100,000 draw calls — before trusting its green. Why new gates need a demonstrated failure, and why this one asserts dc(10k) === dc(100k) instead of pinning an exact count.'
date: 2026-07-11T15:30:00Z
tags: ['testing', 'performance', 'ci']
lang: en
draft: false
---

Ten thousand icons in a retained GPU batch: one draw call per frame. One
hundred thousand icons: still one draw call. That equality is the entire point
of instanced batching — draw calls scale with visible world copies, never with
instance count — and until this week nothing in CI asserted it. The session
that finally pinned it never touched the renderer. It shipped a counter, a
test, and, before trusting either, a failure it caused on purpose.

## The ticket's premise was wrong

The work order read as feature work: implement the drawing API phases — a
sprite atlas, retained icon batches, arrow batches, render gates for each. The
natural first move is to start building. A scope audit against `main` came
first instead, and collapsed the ticket: the sprite atlas had landed in an
earlier PR, the retained icon/arrow batch facade in three more, each already
guarded by a pixel-readback render gate in CI. The features existed. Only one
mandated dimension of the ticket did not: the performance invariant — draw-call
count must not grow with instance count — expressed as a gate.

So the deliverable shrank to exactly that gap, and stayed shrunk: the PR adds
instrumentation and one gate, references the umbrella issue without closing it
(`Refs`, not `Fixes`, since later phases remain), and the next tracked feature
— an animated particle-flow mode — was explicitly not attempted. Its
prerequisite was confirmed present on `main`; the deferral was recorded as a
scope decision, not a blocker dressed up as one.

## The invariant the timing gate could not pin

A performance gate for this batch already existed. It times the retained
render pass per frame at 10k and 100k instances and asserts the timing is flat
— with a 3× slack, because wall-clock time on a shared machine is noise. This
session's run of it: p95 0.200ms at 10k, 0.100ms at 100k. Useful, but it
proves the _consequence_. The _cause_ of flat timing is architectural: a frame
issues exactly one instanced draw per visible world copy per batch, so the
draw-call count is O(copies × batches) and independent of N.

Unlike a timer, that count is deterministic — no GPU clock, no pixel read, no
noise floor. It can be asserted with zero slack, and it reads the same on a
laptop GPU and on CI's software rasterizer. The instrumentation is three small
edits along the path every draw already flows through. The one function that
actually calls `pass.draw`/`pass.drawIndexed` now reports how many draws it
issued:

```ts
      pass.drawIndexed(it.count, instances)
    } else pass.draw(it.count, instances, it.firstVertex ?? 0)
  }
  return items.length
}
```

The per-batch drapers changed signature from `void` to `number` to pass that
up — which means a future draper that forgets to report its count is a type
error, not a silent hole in the gate — while every one of the twelve existing
callers legally ignores the new return value. The manager sums it per frame:

```ts
// Reset the per-frame draw-call count FIRST (before any early return), so a
// frame with nothing drawable honestly reports 0 and the gate reads the most
// recent frame's true count.
this._lastFrameDrawCalls = 0
```

Review flagged one honest limitation that did **not** fire: the count is
`items.length`, computed beside the loop rather than incremented adjacent to
each `pass.draw` call. It is exact today because every item unconditionally
issues one draw — but a future `continue` inside that loop would silently
decouple the counter from the truth. Non-blocking, on the record.

## Red before green

Here is the problem with a brand-new gate: it lands in the same PR as its own
instrumentation, so it has no history of catching anything. Its first green is
consistent with two worlds — the invariant holds, or the test measures
nothing. A vacuous assertion, a counter that never increments, a spec that
exercises the wrong path: all of them are green. The only way to tell the
worlds apart is to construct the broken one and watch the gate notice.

So before any green run was trusted, the icon draper was deliberately broken —
one draw per instance instead of one instanced draw per copy, precisely the
naive path the gate exists to forbid — as an uncommitted local edit, and the
gate ran headed on a real GPU:

```
[#797 P1 draw-call] 10k=10000  100k=100000  (COPIES_MAX=16)
  1) … retained icon draw-call count is N-independent …
    Error: 100k draw calls 100000 must be O(COPIES) <= 16, not O(N)
    Expected: <= 16
    Received:    100000
  1 failed
```

That `Received: 100000` is the most valuable output the gate will ever
produce. It proves the counter reads the real draw site, the spec drives the
real path, and the assertion bites. Revert the break, rerun: `10k=1  100k=1`,
1 passed in 16.5s.

The revert itself misfired. `git checkout -- <file>` restored the draper to
its committed state — which also wiped the uncommitted _legitimate_
instrumentation change sitting in the same file. It had to be re-applied and
verified present, and the canonical typecheck ran a second time after the
re-apply for exactly that reason. A fail-before break usually shares files
with the real fix; revert it surgically, or commit the real work first.

:::warning
A regression gate whose red state you have never observed is decoration. The
fail-before run is not ceremony — it is the only evidence that distinguishes
"the invariant holds" from "the test measures nothing," and both look
identical in green.
:::

## Assert the equality, bound the constant

The gate makes three assertions, in increasing strength: `dc >= 1` at both
sizes (a filtered-empty path or a stale zero fails loud instead of passing
vacuously — the counter reset sits above the render pass's early returns for
the same reason); `dc(100k) <= 16`, ruling out O(N) by five orders of
magnitude; and the core one, `dc(100k) === dc(10k)`, exact, zero slack.

What it deliberately does not assert is the value itself. The observed count
at the pinned camera was 1 — one batch, one visible world copy — on both
backends. Pinning `toBe(1)` would be stronger today and wrong tomorrow: the
count is copies × batches, and the copy fan-out is view-dependent, so an exact
pin converts every legitimate camera or world-copy change into a false red.
The spec bounds it instead:

```ts
// A generous ceiling on the world-copy fan-out — flat Mercator fans to a handful
// of copies at low zoom (never anywhere near a per-item count).
const COPIES_MAX = 16
```

Review named the cost of that choice plainly: a regression in the copy fan-out
itself — 1 copy becoming 16, a 16× per-frame cost — would pass this gate, with
only the timing gate's 3× slack as partial defense. That is an accepted,
documented trade, not an oversight: this gate pins N-independence, and a
copies-count pin would be a different gate. An assertion should hold the
invariant it names and nothing incidental to it.

## Where it ran — and where it did not

The gate passed headed on a real GPU under the forced-WebGL2 path, and in
CI-mode headless under a software rasterizer — the exact configuration CI
runs. It was registered in the CI workflow's render-gate spec list, and the
review pass pulled the PR's actual CI job log to confirm the spec executed
there and printed `10k=1  100k=1`, with the whole leg at 25/25 passed. (A gate
that exists but never runs is the [other way to ship
decoration](/blog/2026-07-08-required-check-never-ran).)

What was _not_ done, stated as plainly as the report stated it: the counter
was never separately captured on native, non-forced WebGPU for this gate. The
mitigation is structural — the counter is backend-blind, since both backends
route through the same `executeItems`, and a sibling gate already exercises
the native retained path — but the gap is a gap, written down rather than
rounded up to "verified on both backends."

One environmental dead end cost real time on the way: the gate was first run
through an output-buffering command proxy while the test runner's
`reuseExistingServer` dev server lingered after the run. The proxy releases
output only when the whole process tree exits; the server never exits — zero
bytes for five-plus minutes, indistinguishable from a hang. The fix was a
persistent dev server the runner reuses, invoked without the proxy. Any
wrapper that withholds output until process-tree exit, plus any long-lived
child, manufactures this same fake hang.

## What generalizes

A regression gate's value is established by its red run, not its green one:
green on day one is evidence of nothing until you have watched the gate refuse
the exact regression it exists to prevent. And once it can fail, make sure it
can only fail for the reason it names — assert the invariant (an equality that
must hold across scale), bound the incidentals (the constants that legitimate
change will move), and write down which environments the evidence actually
came from.

## References

1. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu)
   — the sibling incident about what a green run does not prove: which system
   produced it. This post's native-WebGPU caveat is that discipline applied in
   reverse — naming the backend the evidence did _not_ cover.
2. ["A skipped matrix job never posts the checks you required"](/blog/2026-07-08-required-check-never-ran)
   — why registering the spec in the CI run list was verified against the
   actual job log: a gate that never runs blocks nothing.

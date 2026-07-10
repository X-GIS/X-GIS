---
title: "When the bug is already fixed, the test still isn't"
description: "We adjudicated eight open bug reports in one batch. Two were already fixed on main and one's premise was refuted by a write-only uniform lane. In every stale case the deliverable that survived was a regression test, not a patch."
date: 2026-07-10T23:40:00Z
tags: ['triage', 'testing', 'verification']
lang: en
draft: false
---

The bug report said: replace the last-stop bake at `lower-bindings-line.ts:107-121`
(there's a `TODO` comment). The file's lines 124–141 already contained the full
fix — building the `{ kind: 'zoom-interpolated' }` stroke-colour shape the issue
asked for, under a comment citing the very issue we were assigned — and eleven
existing tests across two files (`line-stroke-color-zoom-interp.test.ts`,
`stroke-binding-routing.test.ts`) already pinned the lowered kind. The bug had
been fixed under another change while its report stayed open, and the report's
`file:line` map had rotted past the fix.

That was not an isolated case. In a batch of eight open bugs worked in
parallel, three turned out to be some flavour of stale: one fully fixed, one
half-fixed, and one whose stated symptom could not occur at all. What shipped
for those three was almost entirely tests.

## The wrong first move

The wrong move was ours, and it was baked into the work order. The fixer's
brief said, verbatim:

> Replace the last-stop bake at lower-bindings-line.ts:~107-121 (TODO comment)
> with the exact construction lower-bindings-fill.ts:~34-42 uses.

It was a tempting instruction to write. The issue was unusually good: exact
file:line references, a named accumulator field, a sibling implementation to
copy from, a `TODO` marker to search for. Reports that precise read as
pre-verified — the diagnosis feels done, only the typing remains.

But a bug report is a snapshot of the code at filing time. In a repository
where the cited region is under active development, the report's symptom ages
well while its `file:line` map and its root-cause claims age badly. A fixer who
starts typing at the cited line — human or agent — re-implements a fix that
exists, or patches a code path that no longer does what the report says.

## What actually happened

The fixer's first act was to adjudicate the claim instead of executing the
brief: read the cited region and trace the full chain before writing anything.
Three reports, three different verdicts.

**Already fixed.** The zoom-interpolated stroke-colour bake was present in
`lower-bindings-line.ts`, self-documenting its own history:

```ts
// #726 — FULL zoom-interpolated stroke colour, the exact construction the
// `name === 'fill'` arm uses. StrokeValue.color is the same ColorValue
// union, and the runtime per-frame path is already wired end-to-end
// (emit-commands wires colorValueToShape(node.stroke.color) →
// renderer.ts resolveColorShape(ps.line.stroke, camera.zoom, …)), so the
// old "bake the highest-zoom stop" placeholder — which snapped every
// zoom-interpolated line colour to its last stop at ALL zooms — is
// replaced by the real stops.
```

What the trace also surfaced: none of the eleven existing tests asserted the
_numeric_ behaviour the issue complained about. They pinned the lowered kind
(`'zoom-interpolated'`), not that a colour authored as red-at-z5 / blue-at-z15
actually resolves to the midpoint at z10 instead of snapping to the last stop.
The kind can be right while the interpolation is wrong; the one assertion that
distinguishes "fixed" from "differently broken" had never been written.

**Refuted premise.** A second report predicted that the heatmap's on-screen
sizing would drift in a low-zoom band because its frame uniform still packed a
raw, uncapped meters-per-pixel — "exactly like line width did" in an earlier,
confirmed bug. Reading the consumer refuted it. The shader declares the lane:

```ts
// viewport: x=width px, y=height px, z=meters/px, w=unused.
viewport: vec4fT,
```

and then the only computational read in the whole accumulation shader is:

```ts
const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
```

`viewport.z` is packed every frame and read by nothing. The predicted symptom
was impossible — not because the value was right, but because the wrong value
was write-only. A report can be correct about the code ("this computes raw
mpp") and wrong about the world ("so the pixels drift").

**Half fixed.** The third report bundled two symptoms. Its headline symptom —
a data-driven fill colour collapsing to the layer default — was already fixed
on main. Its second symptom was real: for a data-driven opacity, the resolver
returned a flat `1`, silently discarding the layer's authored base opacity
while the sibling `strokeWidth`/`size` branches fell back correctly. The stale
half and the live half were separable only by tracing each claim to its own
line.

## The fix

For the stale claims, the patch is the missing test. The already-fixed bug got
the end-to-end numeric gate that eleven kind-assertions never provided:

```ts
it('linear interpolate(zoom, 5 #f00, 15 #00f) resolves the true midpoint at z=10', () => {
  // …style → convert → lower → emit → resolveColorShape…
  expect(atMid!.value[0]).toBeCloseTo(0.5, 5) // R
  expect(atMid!.value[1]).toBeCloseTo(0, 5) // G
  expect(atMid!.value[2]).toBeCloseTo(0.5, 5) // B
})
```

The refuted-premise report still produced a change — the write-only lane was
switched to the correct single-authority value, so the declared contract
(`z=meters/px` that matches what the view renders) is true the day someone
starts reading it, with a wiring gate that fails if the raw computation is
ever re-inlined. And the half-fixed report got a three-line fix for its live
half plus gates for both halves:

```ts
const opacity =
  ps.common.opacity.kind === 'data-driven'
    ? (show.opacity ?? 1)
    : resolveNumberShape(ps.common.opacity, cameraZoom, elapsedMs).value
```

## How we know it holds

"Already fixed" is itself a claim, and it got the same treatment as any other:
each new gate was run against a temporary revert to the reported behaviour.
Re-baking the stroke colour to its last stop flipped the lowered kind back to
`'constant'` and the midpoint test failed exactly as the original symptom
described. Restoring the flat-`1` opacity failed the new test with
`expected 1 to be 0.5`. Re-inlining the raw meters-per-pixel failed the heatmap
wiring gate with the two concrete lane values (`78271.5` packed where `37106.5`
was required) while the byte-equality fixtures above the cap band stayed green
— proving the gate discriminates rather than merely passes. All of it then ran
green in the integrated tree: 7794 tests, plus the CI render gates.

## What generalizes

The uncomfortable part is that the stalest reports were the _best-written_
ones — precise line numbers and a ready fix sketch are exactly what stops a
fixer from re-deriving the diagnosis, and exactly what rots first. So treat a
bug report as a claim to adjudicate, not a work order: the verdict can be
"fix", "already fixed", or "cannot occur", and every verdict ships something.
A stale bug closed without a pinning test is just a bug that hasn't
regressed yet — the fix that landed unreported can leave unreported too.

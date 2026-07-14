---
title: 'The second ratchet: one invariant with two authorities, and a gate we could not run'
description: 'An icon-padding feature grew three compiler files past their LOC ceiling. The PR raised the ratchet it knew about and went green — then CI failed on a SECOND ratchet tracking the same three files with the same numbers. A repo that preaches single-authority had let one invariant grow two authorities, and a local gate nobody knew existed is a gate nobody can run.'
date: 2026-07-14T11:00:00Z
tags: ['ci', 'invariants', 'tooling', 'single-authority']
lang: en
draft: false
---

Lowering one Mapbox layout property — `icon-padding` — added lines to three
compiler files: the converter that emits the utility, the IR pass that parses
it back, and the render-node type that carries the knob. Small, additive, the
same label-plumbing we have shipped a dozen times. The PR (#1102) did the
ritual: it raised the LOC ceiling for its own file growth, ran its local
vitest batch, watched the ceiling gate go green, and queued to merge.

Then CI's `engine-rest` leg failed — in a file the change had never opened:

```
compiler/src/convert/layers-symbol.ts: 1296 > ceiling 1295 — extract, don't grow (then lower the ceiling)
compiler/src/ir/lower-label.ts: 1101 > ceiling 1091 — extract, don't grow (then lower the ceiling)
compiler/src/ir/render-node.ts: 913 > ceiling 908 — extract, don't grow (then lower the ceiling)
```

Three files, three ceilings, each crossed by exactly the lines the feature
added. But the PR had _already_ raised those three ceilings. We had watched
the gate pass. The gate that failed was a different gate — for the same rule.

## The wrong first move

The reflex was to distrust CI. We had a green ceiling check in hand
(`map/src/loc-ceiling-ratchet.test.ts`, on the `test (map)` leg); it listed
`layers-symbol.ts` at 1296, `lower-label.ts` at 1101, `render-node.ts` at 913
— the post-feature values, matching the file sizes exactly. From inside that
file the invariant was satisfied and the CI failure looked like a flake or a
stale cache. It was neither. The mistake was believing that a rule with one
name has one home.

## What actually happened

There are two LOC-ceiling authorities in this repo, and both track these three
compiler files.

The one the feature updated is the newer of the two: `loc-ceiling-ratchet.test.ts`
(#1003), co-located under `map/src` so it rides the `test (map)` CI leg. Its
own header explains why it exists — the older gate "walks only
runtime/compiler/blueprint/shared, so the repo's biggest, fastest-growing
files have NO growth ceiling." So #1003 was written to cover map/engine/geo/
data/rhi\*. But it also carries a block of `compiler/src` ceilings, and a
comment says exactly why:

> #1005 — carried from the retiring runtime arch-invariants Gate 3, whose
> SRC_DIRS walk covered these three trees; without this they go ceiling-dark
> the day runtime/ is deleted.

That is the whole bug in one comment. The compiler ceilings are being
_migrated_ from the old gate to the new one against the day `runtime/` retires
— but `runtime/` has not retired yet, so the old gate's copy is still live.
The old gate is `runtime/src/engine/architecture-invariants.test.ts`, whose
god-file `LOC_CEILINGS` map runs on the `engine-rest` leg and still held
`1295 / 1091 / 908`. For the length of that migration window, one invariant —
_these three files may not grow without an extract_ — has two authorities, and
updating one does not touch the other.

Before this PR the two were in lockstep: at the merge base both files listed
`1295 / 1091 / 908`, identical. The feature raised the map-leg copy and left
the engine-rest copy stale. The two authorities drifted apart by exactly one
commit's worth of growth, and CI is the only place that reads both.

## The fix

Three numbers, in the second file, with the same justification class the map
copy already carried (`ee8f4a0d`):

```
layers-symbol 1295->1296, lower-label 1091->1101, render-node 908->913
```

The commit message names the shape plainly: "The engine-rest CI leg tracks
compiler god-file sizes in architecture-invariants.test.ts, a SECOND authority
alongside map/src/loc-ceiling-ratchet.test.ts (which the feature commit already
updated)." Nothing was extracted, because the growth is irreducible additive
plumbing — a padding accumulator, a parse arm, a struct field. The ceilings
moved; the rule held.

## How we knew where to look

For all the process embarrassment, the diagnosis cost one log read. The gate's
failure string is a complete work order: `compiler/src/ir/render-node.ts: 913 >
ceiling 908` names the file, the measured size, the ceiling, and the delta;
`extract, don't grow (then lower the ceiling)` names the remedy. A grep for
`908` found the second file in seconds. No bisect, no repro, no instrumentation
— the failure text did its entire job. The gate was well designed. The process
around it was not.

## What generalizes

A codebase can hold itself to single-authority for _code_ and quietly violate
it for its _meta_. This repo's guidelines open by demanding single-authority,
zero-coupling invariants; then two test files ended up as parallel authorities
over one growth rule, kept in sync by hand across a migration nobody had
finished. Meta-invariants — ratchets, allowlists, coverage maps, the lists
that police the code — need single authorities exactly as much as the code
does, and they rot the same way when they don't have one. The honest fix is
not "remember there are two"; it is to finish the migration so there is one,
and until then, to make the drift impossible rather than merely detectable.

And there is a smaller, portable rule under it. A local pre-merge checklist is
_remembered_; the CI job matrix is _written down_. The gate we could not run
was one we did not know existed, and you cannot run a gate you cannot name. A
checklist generated from the CI leg list — `test (map)`, `engine-rest`, and the
rest — can never be missing a leg that CI has. The one that lives in a
contributor's head always can.

## References

1. `map/src/loc-ceiling-ratchet.test.ts` (#1003) — the map/engine ratchet and
   the newer authority; its header records that it _carried_ the `compiler/src`
   ceilings from the runtime gate per #1005, which is how one rule came to have
   two homes.
2. `runtime/src/engine/architecture-invariants.test.ts` — the older god-file
   ceiling gate on the `engine-rest` leg; the copy #1102 could not see, and the
   one `ee8f4a0d` had to catch up.
3. `.github/workflows/test.yml` — the CI matrix whose legs (`test (map)`,
   `engine-rest`, `engine-render-a/b`, …) are the real, written-down list of
   gates a pre-merge checklist should be generated _from_, not reconstructed
   from memory.

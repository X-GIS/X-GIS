---
title: 'The coordinates rot before the symptom does'
description: "A package extraction moved the render code to a new package. It changed no behavior, so every open bug report's symptom stayed valid — and every report's file:line pointed at a path that no longer existed. The precise-looking part of a report rots first."
date: 2026-07-11T05:00:00Z
tags: ['architecture', 'refactoring', 'triage']
lang: en
draft: false
---

The bug report was specific in the way you want a report to be: the line
outline jitters at high zoom, and the culprit is
`runtime/src/engine/shaders/dsl/line.ts:237-244`. So I opened it:

```
$ sed -n '237,244p' runtime/src/engine/shaders/dsl/line.ts
$            # nothing — exit 2, no such file
```

The file does not exist. Not moved-and-edited; gone from that path entirely.
The code it named is alive and well at `map/src/shaders/dsl/line.ts` — a
different package. The symptom in the report was still real and still
reproducible. The address had been demolished three weeks earlier by a change
that touched no behavior at all: a package extraction.

Four of the open issues I was triaging pointed into `runtime/src/…` —
`line.ts`, `vector-tile-renderer.ts:3539`, `label-pass.ts:600-633`,
`feature-helpers.ts:107-118` — and every one of those files now lives under
`map/src/…` and is gone from `runtime`. Same code, new home, dead coordinates.

## The wrong first move

The wrong move is the natural one: navigate by the report. A `file:line` is the
most precise field in a bug report, so it reads as the most trustworthy — the
part someone already did the work to pin down. When I seeded a batch of triage
agents, my first instinct was to hand each one the path its issue named. That is
handing a fixer a treasure map to a building that has been torn down.

The precision is exactly what makes it dangerous. A vague report ("labels look
wrong somewhere in the text pass") forces you to go find the code, so you always
land on the current tree. A precise one ("`feature-helpers.ts:107-118`") invites
you to jump straight there — and jumps straight into a `sed` that returns
nothing, or worse, into a stale mirror that still exists but no longer does what
the report says.

## What actually happened

The engine is mid-extraction. A formerly-monolithic `@xgis/runtime` is being
decomposed into focused packages — `@xgis/map` (render / camera / shaders /
text), `@xgis/data`, `@xgis/geo`, and the rest — and the render subsystem has
already moved out. `map` now holds 179 source files; `runtime` is down to 18 and
mostly re-exports the others. The move was a `git mv` at heart: byte-for-byte the
same rendering, so no test changed its result and no PR description mentioned a
behavior delta. Nothing in the issue tracker got a notification. Every report
filed against the old layout kept its symptom and silently lost its location.

This is the property that makes it sneaky. A code change that alters behavior
trips a test, and the red test is a loud signal that some assumption elsewhere
just aged. A pure relocation trips nothing. There is no merge conflict against an
issue body, no CI check that a `file:line` in a three-week-old report still
resolves. The staleness accrues in a system — the tracker — that the compiler
never reads.

The way through was to stop navigating by path and navigate by symbol. Instead
of trusting `runtime/src/engine/shaders/dsl/line.ts`, ask the code graph "where
is `finalize_corner` defined today" and let it answer `map/src/shaders/dsl/line.ts`
— "the only copy," as the trace put it. The symptom told me _what_ was wrong; the
current symbol table, not the report, told me _where_.

## What generalizes

A bug report has two halves with wildly different half-lives. The symptom — what
the user sees — ages slowly; a jitter reported three weeks ago is very likely
still a jitter. The location — the `file:line`, the named function, the "sibling
implementation to copy from" — ages at the speed of your refactors, and a package
extraction ages _all of them at once_, on the day of the move, with no signal.

So treat the coordinates in a report as a lead, not an address, and treat a
recent large-scale move as a tracker-wide cache invalidation you were never told
about. When the most precise line in the report is the first to have rotted, the
fix is to re-derive location from the live symbol graph every time — the report
is authoritative about the bug, never about where the bug now lives.

## References

1. [When the bug is already fixed, the test still isn't](/blog/2026-07-10-when-the-bug-is-already-fixed) — the other way a precise report rots: not a relocation, but a concurrent fix that leaves the symptom described and the diagnosis stale.

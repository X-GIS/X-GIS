---
name: Intent
about: Stage-1 record — why a work item exists, its constraints, and what closes it. Precedes design.
title: '[scope] the outcome, in one line'
---

<!-- The Stage-1 artifact of the AI-native SDLC loop (intent → spec → plan →
diff → PR → incident → intent), kept as an ISSUE rather than a file so this repo
keeps ONE authority for "why does this work exist" (CLAUDE.md §9.5). The design
belongs in `docs/adr/`, the how in `docs/plans/`; neither belongs here.

File this BEFORE starting the work, not after. One issue per shippable unit —
split an epic into per-unit intents tracked from a parent issue. `scope` in the
title is the subsystem, e.g. [render/globe], [map/api], [compiler/tiler].
Delete these comments before submitting. -->

## Problem

<!-- What cannot be done today, quantified — a number, an error string, a
measured cost, not "X is awkward". For a defect with a known symptom and repro,
use the Bug report template instead; this one is for work whose shape is not
settled yet. -->

## Proposed outcome

<!-- What "better" looks like, stated so a reader can tell whether it was
reached. Not the implementation — that is the plan's job. -->

## Affected users and systems

<!-- Who is impacted, and which packages the change would reach (`@xgis/map`,
`@xgis/compiler`, `@xgis/geo`, the shader DSL, the tile pipeline…). Name the
package seams it crosses — the dependency-direction ratchet enforces them. -->

## Constraints

<!-- What the solution MUST respect, recorded the moment it is discovered: a
precision limit, a measured cost, a backend asymmetry (WebGPU vs WebGL2), a
standing ADR. A constraint that is expensive to discover and cheap to forget
WILL be rediscovered the expensive way (CLAUDE.md §9.5). Cite `file:line` or the
ADR number. -->

## Rejected approaches & settled decisions

<!-- Each rejected approach WITH its reason — without the reason it gets
re-proposed, and the reason is the whole value. A decision already made is a
FACT recorded here, not a preference to re-weigh in a later session. -->

## Open questions

<!-- What is genuinely undecided, and who decides it. An empty section means
this intent is ready for design; a full one means it is not. -->

## Verification that closes this

<!-- The evidence that ends this issue, named now while the intent is fresh —
it is the acceptance criterion the PR will paste into. CI has no GPU
(docs/adr/0004): a render outcome needs a LOCAL real-GPU gate — pixel-match Δ,
coverage black-ratio, or a directional pixel-diff (DC>0, D1<D0) — not a unit
test. -->

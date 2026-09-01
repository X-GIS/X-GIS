# How X-GIS keeps a 210k-LOC engine from rotting

> Edition: **dev** — a narrative for engineers. The exhaustive, citation-dense version of
> this chapter is [`../agent/01-architecture.md`](../agent/01-architecture.md).

X-GIS is "HTML/CSS for maps": a declarative style language, a compiler, and a
WebGPU/WebGL2 globe renderer. Thirteen packages, ~210k lines of source — and ~241k lines
of tests, which is the first hint about how the project thinks. This chapter is about the
part of the architecture that usually goes unwritten: not the boxes and arrows, but the
machinery that keeps the boxes and arrows _true_ two years later.

## The DAG lives in a test, not a diagram

Every architecture document eventually lies. X-GIS's answer is to make the package
dependency graph a **literal table inside a test** (`engine/src/dependency-direction-ratchet.test.ts`)
and treat the markdown rendering of it as generated prose. The shape is conventional —
`shared`, `shader-dsl`, `rhi` are leaf packages; `compiler` is a pure-TS front end that
emits no GPU calls; `engine` is a content-blind GPU substrate; `map` is the composition
root that may import everything; `rhi-webgpu` is the _only_ package allowed to see native
WebGPU types. What's unconventional is the enforcement posture, stated in the test itself:

> a boundary survives only when violating it is a mechanical CI failure, not a review
> comment.

The scanner has three assertions, and the interesting one is the first: two _known_ edges
must be seen, otherwise the scanner itself broke and the gate would pass vacuously. That
paranoia is earned — a hand audit of the import graph was once wrong twice in one day (a
regex character class that didn't match a digit in a package name; a `from '…'` pattern
that couldn't see dynamic imports), and the mechanical gate built from that audit found a
missed edge on its first run.

## Ratchets: three semantics, deliberately chosen

X-GIS enforces dozens of structural invariants with "ratchet" tests, and it distinguishes
three kinds on purpose:

- **Ceilings** (fail only when you exceed) for budgets like file size — low friction,
  tolerates regrowth under the line.
- **Strict-equality baselines** (fail when the count _changes in either direction_) for
  leaks being burned down — if you fix a violation, the test forces you to lower the
  baseline in the same commit, so the win is locked and can't silently reopen.
- **Assert-zero** for invariants already achieved.

Two meta-rules apply to all of them, both paid for. First, any allowlist keyed by file
paths gets a companion check that every key still resolves — two gates once sat green for
an entire refactor era because the files they guarded had moved. Second, detectors carry
_liveness proofs_: the gate's own regex must find a planted positive and ignore a planted
decoy. The project's most quotable test-philosophy line applies here: **a gate that cannot
fail is decoration.** When a new draw-call gate was added, they broke instanced batching
on purpose and watched CI go red at 100,000 draw calls before trusting a single green.

The catalog is worth skimming in the agent edition: a single LOC authority whose 2,300
lines are mostly inline rationale (the gate doubles as a change ledger); content-blindness
ratchets that keep geo concepts out of the compiler and style concepts out of the GPU
backends; a raw-`GPU*`-token ratchet that catches what the type checker legally cannot
(map depends on the WebGPU backend, so the types are in scope); a "no hand-written WGSL
string anywhere" lock; and meta-gates that test the CI configuration itself.

## One authority per concept

The dominant bug archetype in a map engine is two sibling paths that must agree —
fill and outline, CPU and GPU projection, tile selection and label projection — drifting
apart. X-GIS's systematic countermeasure is single authorities: a projections table that
every per-projection behavior derives from; one `EARTH` constants object with a literal
ratchet forbidding the numbers anywhere else; shader reflection as the only source of byte
offsets; a pass-order array from which the render chain is built _constructively_
(`ORDER.map(label => PASSES[label])` — it cannot drift, because there is nothing to drift
from); one function that answers "which coverage region owns this pixel" for the three
subsystems that all need the same answer.

When derivation-by-construction isn't possible, the fallback is a single cross-consumer
identity test rather than N pairwise rules. And when a concept accidentally grows a second
authority — a second LOC ratchet, a status column in an ADR, a hand-copied twin of the
pass list — that's treated as the root cause of a future bug and removed. The pass-list
twin is the cautionary tale: the order was once maintained as two hand-copied arrays
(native and a forced-WebGL2 variant), and that duplication was the actual source of a
family of "vanishing labels / missing strokes / double paint" bugs.

## ADRs that record the losing side

The decision records are unusually useful because they follow two rules: append-only (you
supersede, never rewrite), and _the rejected alternative is written down with the
measurement that rejected it_. A few worth reading in full:

- **ECEF tile pipeline (0001)**: pack tiles once as ellipsoid ECEF meters around a
  per-tile anchor; one MVP for every surface; switching projection is a uniform change
  with no re-tessellation. The rejected design — per-surface projection ladders pasted
  into each shader — had already drifted.
- **The geoid split (0002)**: the sphere-vs-ellipsoid camera question was settled by
  measurement, twice — including the discovery that the original measurement was itself
  wrong because the test had mixed frames. The ADR keeps both rounds.
- **Read standards in place (0010)**: the project shipped a bespoke binary container for
  scientific data — twice — before writing down the rule: _a reader for a standard is
  legitimate; transcoding a standard into a house blob is not._ You lose the ecosystem and
  HTTP-range streaming, and gain nothing. "If you're writing a magic number, stop."
- **One producer per uniform block (0009)**: after a field was wired into three of six
  hand-packers, the fix wasn't a guard test but a restructuring — split uniform data by
  _write cadence_ so writer-completeness drift becomes unrepresentable, then delete the
  guard. "A guard test is a ratchet, not a cure. The durable move is to reduce the number
  of places that can be wrong."

## A flat pass list, not a render graph

The frame is thirteen passes in a fixed order (background → atmosphere → flow → opaque →
… → labels → …). The team explicitly considered a general render-graph scheduler and
declined: the cross-pass couplings are a small fixed set, so they're _declared as
metadata_ on a flat list instead — which pass owns which clear, whose depth store depends
on which later passes existing, which passes draw at native resolution versus the scaled
scene target. One nice trick: the "scene passes" set is **derived** (a pass is a scene
pass unless it declares itself overlay or seam), so a newly added pass can't be forgotten
by any of the partitions. The scheduler itself is three lines.

This is the general posture worth taking home: choose the boring, verifiable structure,
but write down where the general option lives so the upgrade is planned rather than
re-litigated.

## What to steal

1. Put the dependency graph in a test; make every boundary a mechanical failure.
2. Pick ratchet semantics per gate; guard allowlists against vacuity; prove detectors
   live; break the feature once before trusting a new gate.
3. One authority per concept; derive consumers; kill second authorities on sight.
4. Prefer making drift _unrepresentable_ (constructive building, cadence-split producers,
   enumerated registries) over guarding it — then delete the guard.
5. Write ADRs append-only, with rejected alternatives and their measurements; name the
   gate that fails on regression.
6. A flat, declared pass list beats a render graph until you truly have dynamic topology.

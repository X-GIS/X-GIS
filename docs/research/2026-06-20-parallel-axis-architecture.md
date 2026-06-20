# Parallel-axis architecture — engineering separability for 4× throughput

**Date:** 2026-06-20
**Status:** in progress — capabilities registry shipped (`47a78247`), rest specced below
**Goal:** make independent feature work (style-spec parity axes, render subsystems)
run in parallel instead of serial, by removing the shared mutable state that forces
serialization.

## The principle

Parallelism is bounded by shared mutable state, not by how many agents you spawn.
A unit of work can run concurrently only if it is **logically separable** (no shared
contract/decision with the other unit) AND **physically separable** (no edit conflict
— different files). When the code doesn't give you that, you have to *engineer* it.
This is an architecture property: you pay once to make the seams separable, then every
future feature parallelizes.

## Why this repo is structurally serial for paint-axis work

Evidence from the WS-1 batch (8 zoom-interp axes, PR #473): the axes could not run in
parallel because every one of them touched the same shared files. The chokepoints,
grounded:

1. **God files** (physical chokepoint). Every paint feature edits the same large files:
   - `runtime/src/engine/render/vector-tile-renderer.ts` (~4000 lines)
   - `compiler/src/ir/lower.ts` (the single binding loop, ~1450 lines)
   - `runtime/src/engine/map.ts`, `point-renderer.ts`
   Two axes editing the same god file conflict → serialized.

2. **Single-authority tables** (logical + physical chokepoint). Every axis hand-edits
   the SAME table:
   - `compiler/src/convert/spec-coverage.ts` (the coverage authority, ~242 entries)
   - `runtime/src/capabilities.ts` (the runtime-honoured flags, 120 rows)
   - `scripts/gap-matrix.md` (derived doc)
   - the `LOC_CEILINGS` in `architecture-invariants.test.ts` (arch-ratchet)

3. **The IR spine** (logical chokepoint). Every paint axis threads a `PropertyShape`
   through the same long pipeline: `convert → lower → emit-commands → render-node →
   runtime`. The shape interface, the `ShowCommand`/`RenderNode` types, and the binding
   loop are shared by all axes.

So the table edits + the IR-spine type edits + the god-file edits forced the WS-1 axes
to run one at a time.

## The fix — engineer separability in four moves

### Move 1 — registry / plugin for the authority tables (HIGHEST leverage)

Instead of every axis editing one shared table file, split the table into **one
descriptor file per layer type**, and have the authority file ASSEMBLE the descriptors.
A change to one layer type touches ONLY its descriptor → append-only → conflict-free →
parallel.

**Shipped for capabilities** (`47a78247`): `runtime/src/capabilities.ts` is now a thin
assembler that spreads `capabilities/{fill,line,symbol,circle,fill-extrusion,background,
raster}.ts`. A circle-axis change edits `capabilities/circle.ts`; a background-axis
change edits `capabilities/background.ts`; they never conflict. Verified faithful: the
assembled `RUNTIME_CAPABILITIES` is the identical 120-row set (missing 0, extra 0), all
drift/freshness/completeness gates green.

**Next:** apply the same split to `compiler/src/convert/spec-coverage.ts` (the larger
authority, ~242 entries). Same mechanic: `spec-coverage/<layerType>.ts` descriptors +
an assembler that preserves the `SPEC_COVERAGE` export + the drift/completeness gates.
Verify identical-set the same way (`git show main:… → set diff`).

### Move 2 — derive the cross-cutting artifacts, don't hand-edit

- `scripts/gap-matrix.md` is ALREADY codegen (`scripts/emit-gap-matrix.ts`, gated by
  `gap-matrix-freshness.test.ts`). Keep it that way; never hand-edit. ✔ (done)
- The arch-ratchet `LOC_CEILINGS` stays manual *by design* (it forces awareness of
  growth), but it is a per-axis edit chokepoint. Mitigation: when fanning out axes in
  worktrees, ceilings are the most common merge conflict — bump them in the integration
  pass, not per-worktree.

### Move 3 — contract-first IR spine

The `convert` side and the `runtime` side both depend on the IR shape contract, not on
each other. If the shape-interface scaffolding (the `*Shape` fields on `ShowCommand` /
`RenderNode` / `StrokeValue`, the binding-loop arm, the resolver) is added ONCE up front
for a batch of axes, then the per-axis converter work and the per-axis runtime-renderer
work parallelize — they only touch the contract. The WS-1 batch did the opposite (each
axis re-touched the IR spine), which is why it serialized. **Pattern:** for a batch of N
axes, land the shared IR scaffolding in one commit, then fan out the N renderer-side
implementations.

### Move 4 — decompose the god files along the seams

This is the repo's existing #1 architecture debt (MODULES.md flags VTR / map.ts /
text-stage). It is ALSO the parallelism enabler: split VTR / lower so that per-axis
logic lives in a per-concern (ideally per-layer-type) module, and axes stop colliding in
one 4000-line file. Highest cost, highest risk, do incrementally behind the contracts
from Move 3. The converter is already fairly split (`layers-circle.ts`, `paint.ts`,
`mapbox-to-xgis.ts`); the runtime is already split by renderer (`point-renderer`,
`line-renderer`, `raster-renderer`). The remaining monoliths are VTR and `lower.ts`.

## The parallel workflow (how to actually run N axes at once)

1. **Scaffold once.** Land the shared IR-spine fields + the registry descriptors' empty
   slots for the batch in a single commit on the integration branch.
2. **Fan out with worktree isolation.** One executor per axis, each in its own git
   worktree (`isolation: "worktree"`), so parallel commits to the (now mostly
   non-overlapping) files don't conflict. Each axis edits its own `capabilities/<type>.ts`
   + `spec-coverage/<type>.ts` descriptor + its renderer file.
3. **Integrate once.** Merge the worktrees; resolve the few genuine shared-file conflicts
   (arch-ratchet ceilings, gap-matrix regen) in one pass; run the full suite ONCE.
4. **Verify cheap-per-change, full-suite-once.** Per-axis: targeted gate (~1s). At
   integration: one full suite (~80s). The WS-1 batch ran the full suite ~5× (~400s
   wasted) — gate-per-change + suite-once is the cost fix.

A `Workflow` script encodes this: a `parallel()`/`pipeline()` fan-out over the axis list,
each stage an executor in a worktree, a final integration + full-suite stage.

## Increment roadmap

- [x] capabilities → per-layer-type registry (`47a78247`)
- [ ] spec-coverage → per-layer-type registry (same mechanic, larger table)
- [ ] batch-scaffold pattern for the IR spine (doc + a reusable helper for the binding loop)
- [ ] VTR / lower.ts decomposition along per-concern seams (incremental, behind contracts)
- [ ] a `Workflow` template for "scaffold-once → worktree fan-out → integrate-once"

## What NOT to do

- Don't split hot per-frame loops or the uniform-pack layout for "separability" — those
  are correctness-critical and shared by design (the CPU↔WGSL agreement archetype).
- Don't auto-derive the arch-ratchet ceilings — the manual bump is the awareness gate.
- Don't fan out before the shared scaffolding lands — you'll just move the conflict into
  the integration pass.

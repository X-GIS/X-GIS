# X-GIS WebGPU Roadmap

Recorded 2026-04-21.

X-GIS chose WebGPU (over WebGL 2) for two reasons:

1. DSFUN double-precision emulation (hi/lo f32 split) that survives
   into camera-relative space at z=22.
2. Access to compute shaders, indirect draw, and large storage
   buffers — things WebGL 2 lacks.

Reason 1 is live. Reason 2 is almost entirely UNUSED — the render
path today is "upload vertex buffer, bind, draw" per tile, no
different from a WebGL 2 pipeline. This doc tracks the work to
actually leverage the compute / indirect features, split into
sessionable phases.

## Phase 1 — Foundation (DONE, commit 2b37674)

- Added `visibleTilesFrustumSampled` alongside the existing quadtree
  DFS. Screen-space sample grid with per-sample unproject-to-ground.
  Aspect-ratio invariant by construction (fixes iPhone-portrait
  bug class without margin heuristics).
- Characterisation tests pin current behaviour so Phases 2-3 can
  measure progress.
- NOT yet wired into the render pipeline.

## Phase 2 — Integration and stabilisation (1 session)

- Add a feature flag in `XGVTSource` / the renderer to switch
  between quadtree DFS and sampled.
- Hook sampled path into the render loop behind the flag.
- E2E A/B: iPhone portrait + landscape, 4-5 camera states each.
- Hard-clamp `camera.pitch ≤ 85°` at the engine boundary — matches
  industry convention and eliminates the "extreme pitch is
  unstable" regime both algorithms fail at.
- Make sampled the default once A/B is green across the fleet.

## Phase 3 — GPU compute port (2-3 sessions)

The sampled algorithm's per-sample work is independent —
parallel-friendly. Port to WGSL compute:

  - `src/engine/compute/gpu-tile-cull.ts`
  - WGSL shader: reads camera MVP + viewport from uniform, reads
    tile bbox storage buffer, writes "visible tile mask" storage
    buffer.
  - Dispatches one workgroup per tile chunk.
  - CPU reads back the visible indices (async via `mapAsync`) OR
    uses them with `drawIndexedIndirect` (no CPU round-trip).

WebGPU-unique value:

  * GPU-side culling — CPU is free for other work.
  * Aspect-agnostic by construction (compute shader operates on
    raw MVP math, no margin fudge).
  * Sets up the Phase 4 indirect-draw architecture.

## Phase 4 — Indirect draw (1 session)

Replace per-tile CPU draw-call loop with a single `drawIndexedIndirect`
that reads visible-tile indices from Phase 3's buffer.

Current render loop issues one bindGroup + draw per tile (~500/frame).
Indirect draw reduces this to one CPU command; GPU iterates the
visible list. Measurable CPU-frame-time drop on tile-heavy scenes.

## Phase 5 — GPU compute sub-tile clipping (1-2 sessions)

Current `XGVTSource.generateSubTile` runs Sutherland-Hodgman on CPU
with an 8/frame budget. At extreme pitch this takes ~20 frames to
drain 150+ sub-tiles.

Port S-H to compute. Each workgroup clips one sub-tile. All 150
done in a single dispatch in microseconds. Budget concept
disappears.

Requires the parent tile's vertex data to be addressable as a
storage buffer, and sub-tile output to land back in a GPU buffer
without CPU round-trip — dovetails with Phase 4.

## Phase 6 — GPU-resident tile cache (longer, multi-session)

Upload all indexed tile vertex data to a single GPU storage buffer
on source load. Render by indirect draw indexing into it. Eliminates
the per-tile upload budget entirely.

Requires rethinking LRU cache (now purely GPU-residency metadata),
per-tile bind group (now encoded in buffer offsets + dynamic uniform
index), and the current tile-eviction LRU policy.

This is where X-GIS moves from "WebGPU-compatible" to
"WebGPU-native". At that point the bug class the current sessions
are fighting (upload budget, ancestor fallback, sub-tile scheduling)
ceases to exist in the architecture.

## How much effort is enabling WebGPU worth?

Current failure pattern: a user-visible bug → diagnose → discover
it's in one of {frustum selection, sub-tile generation, upload queue,
ancestor fallback} → patch. Each patch is local; the class is not
removed. This session fixed three (259d5bc, 448d465, c3512d2) and
each raised new edge cases.

The architectural end-state (Phases 3-6) structurally eliminates
these bug classes:

  * Frustum selection bugs → GPU compute is aspect-agnostic, no
    margin heuristics (Phase 3).
  * Upload budget bugs → buffer persistence + indirect draw
    (Phase 6).
  * Sub-tile scheduling bugs → compute parallelism (Phase 5).

Roughly 5-8 sessions of focused work. Each phase is independently
shippable. The alternative (keep patching) has no endpoint.

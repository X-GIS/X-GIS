# ADR-0009: Frame-invariant uniform block written once by a shared producer

Status: Accepted (partial — projection/cull coupling landed; separate-bind-slot UBO pending)
Date: 2026-06-29

## Context

The polygon / line group(0) uniform (the `Uniforms` / `TileUniforms` struct,
reflect-derived, 272 B) is hand-packed by **six independent CPU writers**:
`vector-tile-renderer.ts` (tiled), `renderer.ts:renderToPass` (non-tiled GeoJSON),
`graticule-renderer.ts`, plus the sibling `point-renderer.ts` / `raster-renderer.ts`
/ `heatmap-renderer.ts` for their own structs. The shader reads the struct in ONE
place (`needs_backface_cull`, `rim_alpha`, the VS transforms); the CPU writes it in
N places, each re-deriving the same values.

#600 added a new field, `globe_eye` (the eye-horizon cull direction), read by the
shared shader cull. The *write* was wired into 3 of the 6 writers (raster/point/
heatmap) and **silently missing from the 3 vector writers**. Because the shader has
a defensive fallback (`globe_eye.w == 0` → centre-hemisphere cull), the miss did not
crash or render obviously wrong — it leaked far-side geometry only at high pitch /
finite altitude near the limb (#663). The follow-up to wire the vector path was noted
in a commit message and evaporated; a stale `.vite` cache masked it during review.

This is not a one-off. It is the signature of a **shared contract maintained by
convention across N sites**:

- **Layout drift** — hand-coded struct sizes diverging from the DSL struct.
  *Already addressed* by reflect-derived sizes (ADR-0003 lineage,
  `*-uniform-slots.ts`, the `no-eager-uniform-reflect` gate).
- **Writer-completeness drift** — a field is read but not every writer populates it
  (`globe_eye`). **Not addressed** structurally; currently held by a stop-gap guard
  (`frame-uniform-writer-completeness.test.ts`: any writer of `proj_params` must also
  write `globe_eye`).
- **Semantic drift** — a default value doubles as "unset" (`globe_eye == 0`), so a
  missing write degrades silently instead of failing loudly.

A guard test is a *ratchet* (it catches a regression after someone writes it and
accretes over time), not a *cure*. For a long-lived library the durable move is to
**reduce the number of places that can be wrong**.

## Decision (proposed)

Split the group(0) uniform into two blocks by *cadence*, not by renderer:

1. **Frame-invariant block** — the fields that are identical for every renderer in a
   frame: `mvp`, `proj_params`, `globe_eye`, `log_depth_fc`, `zoom` (and the camera
   anchor terms that are frame- not tile-scoped). Packed **once per frame** by a
   single shared producer (a `FrameUniform` writer that takes the resolved
   `FrameView` from the camera and emits the bytes). Every render path **binds** this
   block; none re-derives it.

2. **Per-draw block** — only what genuinely varies per draw: `tile_origin_merc`,
   `cam_ecef_off_{h,l}`, `clip_bounds`, `pick_id`, `tile_dequant_*`, the per-layer
   colour / extrude / pattern fields. Stays per-renderer (it is genuinely different
   per tile / layer / world-copy) and rides the existing dynamic-offset ring.

With the frame block written in one place, "`globe_eye` missing from 3 of 6 writers"
becomes **unrepresentable** — there is one writer. Adding a future frame field
(another cull parameter, a time uniform) lands in one producer and every consumer
gets it by construction. The completeness guard becomes redundant and is deleted.

Supporting principles (carry forward regardless of when step 2 lands):

- **Single source of truth must be total, not partial.** The reflect-from-DSL layout
  source (ADR-0003) should leave no API surface for a hand-coded size — prefer making
  the literal unrepresentable over catching it after the fact.
- **A default must not double as "unset".** Where a frame field has a meaningful
  zero, carry an explicit `valid` signal (or make "unwritten" unrepresentable via the
  single producer) and `devAssert` on the invalid case — robustness defaults should
  scream in dev, not degrade silently.
- **Verify by domain invariant, not pinned example.** The #600 leak lived in an
  un-sampled camera regime; metamorphic invariants swept over pitch × altitude ×
  lon/lat (e.g. "no occluded-hemisphere fragment is kept") outlast specific-camera
  screenshots as projections and contributors change.

## Consequences

- **Cost.** Touches every group(0) writer (`vector-tile-renderer.ts`,
  `renderer.ts`, `graticule-renderer.ts`) and the bind-group layout (two bind slots:
  a frame UBO bound once + the per-draw dynamic block). Several of these are god-files
  with size ceilings; the work must be staged and individually verified, NOT a
  big-bang rewrite. The point / raster / heatmap structs can adopt the same split
  incrementally (their globe_eye writes already concentrate the frame fields).
- **Benefit.** Removes the writer-completeness drift class at the root; shrinks each
  per-draw pack; makes the frame contract a single, typed, testable surface.
- **Migration / staging.**
  1. *(landed, #663)* Restore the missing `globe_eye` writes + the stop-gap
     completeness guard (`frame-uniform-writer-completeness.test.ts`).
  2–3. *(landed, this ADR's PR)* **Couple the drift-prone pair at the source.**
     `frame-projection-uniform.ts:writeFrameProjectionUniform` writes `proj_params`
     + `globe_eye` TOGETHER; the three polygon/line group(0) writers
     (vector-tile-renderer / renderer.renderToPass / graticule) route through it, so a
     "projection set, eye forgotten" partial write is now unrepresentable for that
     family (no separate-bind-slot needed — same buffer, one coupled writer). The
     completeness guard auto-narrowed to the families that still hand-pack their own
     struct (raster / heatmap); it is deleted when they adopt the same coupled writer.
  4. *(landed)* Generalized the coupled writer to ALL families via
     `writeProjectionCull(f32, projSlot, eyeSlot, …, projParamsW)` — raster/heatmap/
     point now route through it (raster passes `log_depth_fc` as `proj_params.w`).
     EVERY family that sets the projection now sets the eye in the same call, so the
     stop-gap completeness guard was DELETED (no hand-packers remain).
  5. *(pending — needs real GPU)* Optionally lift the frame group into a SEPARATE
     per-frame UBO bound once (a perf refinement over the current shared-buffer pack:
     bind frame data once instead of copying it into every per-draw slot) + a
     GPU-readback `devAssert` that the bound frame block matches the camera frame on
     the globe path (debug-toolkit cross-path-assert pattern). This changes the WGSL
     struct + every pipeline's bind-group layout, so per ADR-0004 it must be verified
     on a real GPU (CI is no-GPU) before merge — NOT a headless-only change.

This ADR is **Accepted (partial)**: the direction is decided and the projection/cull
coupling — the exact #600 drift — is implemented for the polygon/line family. The
broader generalization + the bind-once UBO are tracked follow-ups. Recording the
staging here so the rationale does not evaporate the way the #600 follow-up did.

## References

- ADR-0003 — Shader DSL single-emit + reflect-from-DSL as the layout source of truth.
- `runtime/src/engine/render/frame-uniform-writer-completeness.test.ts` — the stop-gap
  guard this ADR's step 3 will retire.
- `runtime/src/engine/render/no-eager-uniform-reflect.test.ts` — the layout-drift gate.
- `runtime/src/engine/render/globe-eye-uniform.ts` — the shared `globe_eye` value helper
  (the frame producer's first inhabitant).
- PR #663 / issue #600 — the leak that motivated this record.
- `.claude/skills/render-error-budget` — domain-invariant verification over sampled cameras.

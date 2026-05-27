# PR 2d.1B — `packECEFLineSegments` stride-11 + call-site swap — BLOCKER

**Status:** Partial. `packECEFLineSegments` extended to stride-11 (added per-vertex corner ENU offset). Fuzz tests extended. Tiler call-site swap (steps 4-5 of the directive) **deferred** to PR 2d.1C — blocked by `buildLineSegments` stride compatibility.

## Why call-site swap is blocked in 2d.1B

The directive said: "Replace each `packDSFUNLineVertices(...)` call with `packECEFLineSegments(scratch, tileEcefCenter)`. **CRITICAL**: feature flag this. The downstream consumer (vs_line) still reads stride-20 layout via PR 2d.1A (unchanged). Both DSFUN AND ECEF outputs may need to coexist temporarily — OR the consumer is robust to stride growth (PR 2d.1A made it so by appending new floats)."

PR 2d.1A only changed the **LineSegment storage stride** (output of `buildLineSegments`) from 20 → 26. The **per-vertex input** to `buildLineSegments` is still stride-10 DSFUN, produced by `packDSFUNLineVertices`. The slot layout `buildLineSegments` requires is:

| slot | meaning |
|------|---------|
| 0..3 | `mx_h, my_h, mx_l, my_l` |
| 4    | `feat_id` |
| 5    | `arc_start` |
| 6..9 | `tin_x, tin_y, tout_x, tout_y` |

`packECEFLineSegments` (post-2d.1B) emits per-vertex stride-11: `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, abs_lon, abs_lat, enu_x, enu_y, enu_z]`. Slot 4 of this is `ey_l`, not `feat_id`. Direct call-site swap would corrupt `buildLineSegments`:

1. `vector-tile-renderer.ts:2300, :2553` invoke `buildLineSegments(data.lineVertices, data.lineIndices, lineStride, ...)` with `lineStride: 10` detected from `data.lineVertices.length / vertCount`. After the swap, the detected stride would be 11 — `buildLineSegments` doesn't have a `stride: 11` branch (only `5 | 6 | 10`).
2. Even if a stride-11 branch were added, the slot semantics don't match. `feat_id` at slot 4 of the ECEF output is `ey_l` (low half of ECEF y) — wrong type, would break the `heights`/`widths`/`colors` lookups.
3. `sub-tile-generator.ts:351` also produces stride-10 DSFUN outline vertices. Both producer + consumer must migrate together.

**Conclusion:** the per-vertex stride change cannot be additive in the way `packECEFLineSegments` is currently shaped. Migration requires reshaping `packECEFLineSegments` (or producing a parallel per-segment ECEF buffer) AND teaching `buildLineSegments` / `vs_line` to consume the new layout. That's PR 2d.1C scope (vs_line + LineSegment storage migration).

## What PR 2d.1B actually shipped

1. `packECEFLineSegments` per-vertex stride 8 → **11** (added per-vertex corner ENU offset vec3 at slots 8-10).
2. Updated fuzz test cases for the new 3 ENU offset slots — assert finite, assert geometric consistency at lat=0 + lat=85 fixtures.
3. Documentation of the stride-11 layout in the doc-comment.

No tiler call-site swaps. No sub-tile-generator changes. No vs_line / renderer changes. `packDSFUNLineVertices` retained.

## Recommended next steps

**PR 2d.1C** (next session) must do all three together (it's the multi-file vs_line rewire + LineSegment storage migration the blocker doc described):

1. Update `buildLineSegments` to either (a) accept stride-11 ECEF per-vertex input AND read feat_id/arc from a SEPARATE buffer the tiler already produces (lineIndices doesn't carry per-vertex featId, so we'd need a parallel `lineFeatures: Uint32Array`), OR (b) emit per-segment ECEF data structured to match the LineSegment storage struct directly (skip the per-vertex intermediate).
2. Tiler call-site swap at `vector-tiler.ts:1552, :1556, :1784, :1788` + `sub-tile-generator.ts:351`.
3. `vs_line` consumes the new LineSegment storage slots for ECEF clip.

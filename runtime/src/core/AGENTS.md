<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# core

## Purpose
GPU-free primitives that the rendering and worker layers both depend on. These modules carry the load-bearing CPU math (SDF line-segment quad generation, polygon/wall mesh quantization, async fetch scheduling) but pull in NO WebGPU and NO WGSL, so MVT compile workers and unit tests can import them directly. The runtime renderer classes re-export their public surfaces.

## Key Files
| File | Description |
|------|-------------|
| `line-segment-build.ts` | Builds the SDF line-segment storage buffer (stride 20 f32 / 80 bytes): DSFUN p0/p1 high+low pairs, prev/next tangents, arc_start, line_length, miter pad ratios, per-segment `z_lift_m` and `width_px_override`. Miter-pad math mirrors the shader. Extracted from `line-renderer.ts`. |
| `polygon-mesh.ts` | `quantizePolygonVertices(Extruded)` (Float32×5 stride-20 → packed u16×2 + f32 stride-8, `is_top` flag in bit 15) and `generateWallMesh` for 3D extrusion side walls. `EXTRUDE_FALLBACK_HEIGHT_M = 50`. |
| `priority-queue.ts` | Concurrency-limited async work scheduler (TS port of NASA-AMMOS 3DTilesRendererJS PriorityQueue). Sort+pop dispatch; FIFO without a priority callback. Used for tile-fetch scheduling. |

## For AI Agents

### Working In This Directory
- These files must stay WebGPU-free — they are imported by worker threads. Do not add GPU types or `@webgpu/types` usage here.
- The line-segment stride and field layout MUST match the WGSL `LineSegment` struct in `engine/render/line-renderer.ts`. The header comment documents the byte layout — keep both in sync.
- `EXTRUDE_FALLBACK_HEIGHT_M` is shared by `polygon-mesh.ts` (wall top) and the line outline `z_lift_m`; divergence has previously caused patchy building outlines. Both paths must read this one constant.

### Testing Requirements
- Heavily fuzzed: `line-segment-build-fuzz.test.ts`, `boundary-cap-suppression.test.ts`, `polygon-mesh.test.ts`, `priority-queue.test.ts`. Add a colocated test for any new packing/scheduling logic.

### Common Patterns
- Pure functions over typed arrays; return new buffers, no shared mutable state. DSFUN high/low f32 split for positions.

## Dependencies

### Internal
- `@xgis/compiler` types only (`RingPolygon`).

### External
- None (deliberately GPU-free and dependency-free).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

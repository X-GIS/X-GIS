<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# shaders

## Purpose
Shared WGSL string blocks that every renderer concatenates into its inline shader. These are the single sources of truth for GPU code that would otherwise be copy-pasted (and drift) across renderers: the projection function block (all 7 projections in WGSL), the logarithmic-depth-buffer functions, and common SDF distance helpers.

## Key Files
| File | Description |
|------|-------------|
| `projection.ts` | `WGSL_PROJECTION_CONSTS` + `WGSL_PROJECTION_FNS` — the GPU projection block (Mercator/equirect/NE/ortho/azimuthal/stereo/oblique). Consumed by polygon, line, point, raster shaders. SOURCE OF TRUTH for CPU↔GPU parity. |
| `log-depth.ts` | `WGSL_LOG_DEPTH_FNS` + `computeLogDepthFc` — Three.js-equivalent logarithmic depth buffer (distributes 24-bit depth precision logarithmically; fixes z-fighting at high pitch where standard depth gives ~10 bits near the far plane). |
| `sdf.ts` | `WGSL_DIST_TO_SEGMENT` and friends — common signed-distance-field functions shared by point + line renderers. |

## For AI Agents

### Working In This Directory
- `projection.ts` (WGSL) is the source of truth for projection math. Any change here must be mirrored in the CPU `engine/projection/projection.ts` AND the shader-DSL graph `engine/shader-dsl/projections.ts` (which regenerates the cpu-f64 lowering `engine/shader-dsl/cpu-projections.ts` — formerly the hand-maintained `projection-wgsl-mirror.ts`, now deleted). The parity tests compare all three. This is a documented recurring divergence point.
- These are plain template strings tagged with the `wgsl` block-comment marker (the literal sequence `slash-star wgsl star-slash` placed immediately before the backtick); they get string-concatenated, so keep WGSL identifiers globally unique and avoid reserved words (gated by `wgsl-reserved-words.test.ts`). Phase 4+ progressively replaces these with `shader-dsl/shaders/*` ModuleDecl emits — see `docs/shader-dsl/PHASE-3-SCOPE.md`.
- Log-depth FC must be computed consistently on CPU (`computeLogDepthFc`) and applied in the WGSL block — they pair up.

### Testing Requirements
- `wgsl-reserved-words.test.ts` (no WGSL reserved identifiers). Parity is enforced from `engine/projection/projection-wgsl-consistency.test.ts`. Add a parity assertion when adding a projection function.

### Common Patterns
- Exported `const WGSL_* = <wgsl-tag> \`...\`` blocks (where `<wgsl-tag>` is the block-comment marker described above), concatenated by renderers at pipeline-build time. Phase 4+ targets convert these to `emitFooWgsl()` calls backed by `shader-dsl/shaders/foo.ts` ModuleDecl emits.

## Dependencies

### Internal
- None (consumed by `engine/render/*` and `engine/projection/camera`).

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

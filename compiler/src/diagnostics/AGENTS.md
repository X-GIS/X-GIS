<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-23 -->

# diagnostics

## Purpose

Compile-time optimisation profile for a compiled `Scene`. Composes four analysis modules (`ir/deps`, `ir/passes/cse`, `ir/passes/annotate-deps`, `codegen/compute-plan`, `codegen/palette`) into a single structured report answering "what did the compiler do and what could it do better?" Used by style authors, regression tests, and the Playground `/diagnostic` panel. No GPU resources are allocated; the module is purely read-only over the Scene.

## Key Files

| File               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | Barrel re-export of the module's public API: `getStyleProfile`, `formatStyleProfile`, and TypeScript types (`StyleProfile`, `DepHistogramRow`, `CSESummary`, `ComputePlanSummary`, `PaletteSummary`, `MatchArmBand`).                                                                                                                                                                                                                       |
| `style-profile.ts` | Exports `getStyleProfile(scene): StyleProfile` and `formatStyleProfile(p): string`. Defines `StyleProfile`, `DepHistogramRow`, `CSESummary` (redundancy %, top-8 dup candidates), `ComputePlanSummary` (entries + unique kernel count after WGSL-fingerprint dedup), `PaletteSummary` (colors/scalars/gradients), and `MatchArmBand` (arm-count histogram bucketed at 1-3/4-7/8-15/16-31/32+). Also re-exports `formatDeps` from `ir/deps`. |

No subdirectories.

## For AI Agents

### Working In This Directory

- This module is strictly read-only: `getStyleProfile` never mutates the `Scene`. Keep it that way — no GPU allocation, no side effects.
- All data must come from the established analysis modules (`annotateDeps`, `analyzeCSE`, `collectPalette`, `planComputeKernels`). Do not re-derive data already produced by those passes.
- `match()` arm counts are walked via a dedicated AST walk in `getStyleProfile` rather than reusing CSE entries; this is intentional (CSE deduplication would distort raw arm-count distribution).
- The `formatStyleProfile` pretty-printer mirrors the struct layout exactly; keep both in sync when adding new profile sections.
- `formatDeps` is re-exported here as a convenience so callers building custom views do not need a separate import from `ir/deps`.

### Testing Requirements

- Colocated `style-profile.test.ts` asserts `StyleProfile` shape and values against representative scenes. Snapshot the profile in tests; unexpected inflation of `computePlan.uniqueKernels` or shrinkage of palette coverage should fail.

### Common Patterns

- New report sections follow the pattern: add a typed interface, compute in `getStyleProfile`, append a formatted block in `formatStyleProfile`, and add a snapshot assertion in `style-profile.test.ts`.

## Dependencies

### Internal

- `../ir/render-node` — `Scene` type
- `../parser/ast` — `Expr` type (for match-arm AST walk)
- `../ir/passes/cse` — `analyzeCSE`
- `../ir/passes/annotate-deps` — `annotateDeps`
- `../ir/deps` — `Dep`, `formatDeps`, `DepBits`
- `../codegen/palette` — `collectPalette`
- `../codegen/compute-plan` — `planComputeKernels`

### External

- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

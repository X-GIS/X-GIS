<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# diagnostics

## Purpose
Compile-time diagnostics for a compiled scene. Composes the analysis modules shipped across plan phases 0/3/4 (dependency histogram, CSE summary, compute plan, palette, match-arm bands) into a single human- and tooling-readable optimization profile — answering "what did the compiler do to this scene, and what could it do better?" Used by tooling and developers inspecting style compile quality.

## Key Files
| File | Description |
|------|-------------|
| `style-profile.ts` | `getStyleProfile(scene)` / `formatStyleProfile` + `StyleProfile`, `DepHistogramRow`, `CSESummary`, `ComputePlanSummary`, `PaletteSummary`, `MatchArmBand`. Aggregates the cross-phase analyses into one report. |

## For AI Agents

### Working In This Directory
- This is a read-only diagnostic — it analyzes a `Scene`, never mutates it. Keep it pure so it can run on any compiled scene without side effects.
- It composes existing analyses (`ir/deps`, `ir/passes/cse`, `codegen/compute-plan`, `codegen/palette`); add new report sections by consuming those modules, not by re-deriving their data.

### Testing Requirements
- Colocated `style-profile.test.ts`. Asserts the profile shape against representative scenes.

### Common Patterns
- A struct of summaries (`StyleProfile`) + a `format*` pretty-printer; banner comment ties sections back to plan phases 0/3/4.

## Dependencies

### Internal
- Imports `ir/deps`, `ir/passes/cse`, `codegen/compute-plan`, `codegen/palette`, `ir/render-node`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

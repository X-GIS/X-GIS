---
name: author-architect-refactor
description: Drive a large refactor / package-extraction under strict author↔architect separation — an architect writes an in-repo design doc and Socratically self-critiques boundaries BEFORE any code, then an author executes incrementally with build + vitest + real-GPU verification per increment. Use when the user asks to "refactor this module", "extract a package", "split boundaries", or do an architecture-guardrail refactor on X-GIS.
---

# Author ↔ architect refactor (X-GIS)

Evolve architecture safely: design-doc-first, self-critiqued boundaries, one verified PR per increment. Built for a 5+ year library where a shortcut compounds (CLAUDE.md preamble).

## Hard constraints (X-GIS reality)

- **Agent-tool delegation is BLOCKED** (tmux swarm not installed) — run the two "roles" as separate PASSES in-session (author pass, then a distinct architect/review pass), or via the Workflow tool if opted in. Never self-approve authoring in the same active lane.
- **engine must stay GENERIC / content-blind**; geo → `@xgis/map` / `@xgis/geo`; `map/src` uses **no raw WebGPU** (all via engine RHI). Respect the zero-coupling bar and the arch-ratchet (`runtime/src/engine/architecture-invariants.test.ts`).
- **`bun run build` is the typecheck authority**; shader-dsl is the SOLE shader generator (no hand WGSL); WebGL2 parity is mandatory.
- Serialize heavy jobs (§7). Measure a shim's blast radius with the compiler, not by eye.

## Flow

1. **Architect pass — design doc FIRST.** Write an in-repo doc (`docs/architecture/<name>.md`) proposing the new package boundaries, dependency direction, and the single-authority for each concept. Then **Socratically critique it**: where does it couple? what leaks content into a generic layer? which edge does it add that the ratchet forbids? Reject the weak version before code exists. **Do not touch code until the doc is approved.**
2. **Author pass — incremental extraction.** Execute one increment at a time (extract file / relocate module / add boundary). Each increment:
   - passes `bun run build` (0 new TS errors) and affected vitest,
   - passes a **REAL-GPU verification** run where rendering is touched — actual device + readback, check for missing usage flags (e.g. `COPY_SRC`), §5 pixel-diff for any visual change. A downscaled eyeball is not verification.
   - stays surgical (§3): every changed line traces to the extraction.
3. **One verified PR per increment**, with the design doc committed alongside the first. Bump the arch-ratchet only with justification.
4. **Verify on disk / green CI** before merge; never proceed to the next increment on an unverified one.

## Codemod caution

Regex codemods over-split on greedy `[\s\S]*?` — prefer `[^{}]*` scoped matches; verify the diff, don't trust the sweep.

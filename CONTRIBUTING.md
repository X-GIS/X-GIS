# Contributing to X-GIS

X-GIS is a long-lived (5+ year horizon) library where **architecture quality is
the deliverable** ([DESIGN.md](DESIGN.md), [docs/redesign/VISION.md](docs/redesign/VISION.md) §0).
Changes are judged the way a senior engineer would judge them in five years, not
by how fast they land. This page is the short version; the linked docs are
authoritative.

## Setup

```bash
bun install
bun run dev          # playground → http://localhost:3000
bun run test         # vitest (the no-GPU suite)
bun run lint         # eslint
bun run format:check # prettier
```

Requires a WebGPU-capable browser to run the app; there is no Canvas2D/WebGL
fallback (see [README.md](README.md)).

## Workflow (trunk-based)

`main` is the single integration branch — always green, always demo-ready. There
is no `dev` branch. Full rationale in [docs/BRANCHING.md](docs/BRANCHING.md).

1. Branch off `main`: `<type>/<kebab-summary>` where `type` ∈
   `{feat, fix, docs, chore, refactor, test, ci, perf}`.
2. Small, focused commits. **Conventional-commit** titles (`type(scope): …`,
   enforced by the commit-msg hook); the body says _why_ and records the
   verification run. AI-assisted commits keep the `Co-Authored-By` trailer.
3. **One PR per coherent change**, individually green. Fill in the PR template.
4. **Squash-merge** to `main` → one `type(scope): summary (#NNN)` commit. Linear
   history, no merge bubbles; delete the head branch on merge.

## The bar for a change

From [CLAUDE.md](CLAUDE.md) — these override "just make it work":

- **Simplicity first.** The minimum code that solves the problem; nothing
  speculative. If 200 lines could be 50, write 50.
- **Surgical changes.** Touch only what the task requires. Match the surrounding
  style. Don't refactor what isn't broken; don't delete pre-existing dead code —
  mention it instead.
- **Think before coding.** State assumptions; surface trade-offs; if a report is
  a hypothesis, adjudicate it before typing (a bug report's `file:line` map rots
  fastest in an actively-developed region).

## Verification — the part that is not optional

**CI has no GPU** ([docs/adr/0004](docs/adr/0004-verification-gate-strategy.md)).
GitHub Actions runs only the pure-compute / WGSL-compile gates under SwiftShader.
So `main` protection is two tiers, and a green CI is _necessary, not sufficient_:

- **No-GPU gates (CI):** `vitest`, lint/format, typecheck, WGSL-compile, and the
  ratchets (LOC ceilings, dependency-direction, earth-literal). If you
  intentionally grow a god-file or add a dependency edge, bump the ratchet with a
  comment explaining why.
- **Real-GPU gate (local / pre-push):** render-correctness — pixel-match,
  coverage black-ratio, directional pixel-diff — runs on a real GPU before you
  open or merge. **Record the numbers in the PR.** The screenshot matrix is the
  discovery tripwire; the deterministic numeric gate is the proof of record
  ([docs/verification/STRATEGY.md](docs/verification/STRATEGY.md)). Never claim a
  render is correct you have not seen; mark it pending if the GPU pass is owed.

Prefer catching precision/frame-consistency bugs **by construction** — a
closed-form error budget, a single-authority type, a metamorphic invariant —
before rendering. See the `render-error-budget` and `compare-parity-pixeldiff`
skills under `.claude/skills/`.

## Where things live

The engine is mid-extraction from the `@xgis/runtime` umbrella into focused
packages: `@xgis/map` (render / camera / shaders / graphics / text), `@xgis/data`
(tiles / loaders), `@xgis/geo` (projections), `@xgis/engine`, `@xgis/compiler`
(the DSL), `@xgis/shader-dsl`, `@xgis/rhi*` (backends), `@xgis/shared`. Package
boundaries are enforced by the dependency-direction ratchet — read
[AGENTS.md](AGENTS.md) and the per-package `AGENTS.md` before moving code across a
seam.

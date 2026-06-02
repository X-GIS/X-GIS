# Architecture Decision Records

This directory holds X-GIS's **Architecture Decision Records (ADRs)** — short
notes that capture *why* a structural decision was made, the alternatives that
were rejected, and what the decision costs us going forward.

## Why ADRs (vs AGENTS.md)

The repo already has ~80 per-directory `AGENTS.md` files. Those describe the
**WHAT**: what a directory contains, which file does what, how to run its tests.
That layer decays slowly and is regenerated mechanically.

ADRs capture the **WHY**, which decays fastest of all. A decision like "earcut
runs in Mercator space, not lon/lat" or "the camera ECEF basis is a sphere while
the vertex ECEF basis is the WGS84 ellipsoid" looks arbitrary — even wrong —
until you know the bug it prevents. That rationale lives in commit messages,
test-file headers, and one engineer's memory, and it evaporates. When a later
contributor "simplifies" the decision away, the original bug returns. ADRs pin
the rationale next to the constraint so the cost of reverting is visible.

```
AGENTS.md   →  WHAT it is        (per-directory, regenerated, decays slowly)
COORDINATES →  the CONTRACT      (canonical, enforced by invariant tests)
ADR         →  WHY we chose it   (per-decision, append-only, decays fastest)
```

ADRs are **append-only**. We do not edit a decided ADR to reflect a new
direction — we write a new ADR that supersedes it and flip the old one's status
to `Superseded by ADR-NNNN`. The trail of superseded records is the point.

## Index

| ADR | Title | Status | One-line |
|-----|-------|--------|----------|
| [0001](0001-ecef-tile-pipeline.md) | ECEF tile pipeline — single MVP, ellipsoid vertices | Accepted | Tiles pack WGS84-ellipsoid ECEF metres (quantized double-u16 about a per-tile RTC anchor) drawn with one `u.mvp`; the legacy dual Mercator/ECEF MVP was retired (polygon stride 256→192 B). |
| [0002](0002-geoid-sphere-camera-ellipsoid-vertex.md) | Geoid split — ellipsoid vertices, sphere camera basis | Accepted | Vertices/bg/walls use the WGS84 ellipsoid; the flat-MVP camera basis stays a sphere (`#189` pins the ≤1.5 px gap). Gotcha: the globe RTC `cam_ecef_off` must use the *same* ellipsoid or the ~21 km gap scales with zoom (bug #208). |
| [0003](0003-shader-dsl-single-emit.md) | Shader DSL single-emit + `PROJECTIONS` table SoT | Accepted | One TS DSL emits both WGSL and the CPU-f64 mirror (byte-drift gate forbids divergence); `projections-table.ts` is the single authority for per-`projType` data. |
| [0004](0004-verification-gate-strategy.md) | Two-tier verification — no-GPU CI vs real-GPU local | Accepted | GitHub CI (no GPU) runs only pure-compute/compile WGSL gates under SwiftShader; render-correctness (pixel-match, globe render, eyeball) runs local/pre-push on real GPU. |
| [0005](0005-synthetic-earth-surface-background.md) | Background fill as a synthetic earth-surface tile | Accepted | The style background renders via a synthetic z=0 ShowCommand through the polygon pipeline (BackgroundRenderer deleted) so bg shares one geoid + projection + world-copy logic with real tiles. |
| [0006](0006-world-copy-rendering.md) | Per-`projType` world-copy enumeration | Accepted | Mercator derives a tight on-screen copy range; periodic flat (1/2/6) use a static ±2 set gated by `WORLD_COPY_MAX_ZOOM`; azimuthal/globe collapse to `[0]`. The flat-Merc fill arm must re-add `world_off_m` (bug #212). |

> The rendering backend is **WebGPU-only**. When `navigator.gpu` or a GPU
> adapter is absent, `initGPU` throws `WebGPUUnavailableError`
> (`runtime/src/engine/gpu/gpu.ts:126,136`) and the map fires
> `onWebGPUUnavailable()` and simply does not mount
> (`runtime/src/engine/map.ts:616`). There is no live Canvas 2D render path in
> `runtime/src/`. If a Canvas 2D fallback is ever built, record that decision as
> a new ADR here.

## Template (MADR-style)

Copy this for new records. Number sequentially (`NNNN-kebab-title.md`). Keep it
short — a screen or two. Prose may be Korean; titles, headings, and identifiers
stay in English (the repo mixes EN/KR).

```markdown
# NNNN. <Short decision title>

- **Status:** Proposed | Accepted | Deprecated | Superseded by ADR-MMMM
- **Date:** YYYY-MM-DD
- **Deciders:** <who / which session>

## Context

What forces are in play? What problem or bug pushed this decision? Cite the
code, the test, or the commit that makes the constraint real
(`file.ts:line`). State the alternatives that were on the table.

## Decision

The choice, stated as one clear sentence: "We will ...". Then the mechanism —
which file owns it, which test pins it.

## Consequences

What gets easier, what gets harder, what we now have to keep honoring. Include
the *cost* — the thing a future contributor will be tempted to "simplify" and
must not. Link the gate test that fails if they try.
```

### Status values

| Status | Meaning |
|--------|---------|
| `Proposed` | Written down, not yet agreed. |
| `Accepted` | In force; code reflects it. |
| `Deprecated` | No longer recommended, but not yet replaced. |
| `Superseded by ADR-MMMM` | Replaced by a newer record; kept for history. |

## Conventions

- **One decision per file.** If a record needs "and also", split it.
- **Cite real anchors.** Every claim should trace to a `file:line`, a test
  name, or an existing doc (`docs/COORDINATES.md`). No invented APIs or flags.
- **Pin it with a test where one exists.** The strongest ADRs name the gate
  that fails on regression — e.g. `projections-table.test.ts`,
  `polygon-variant-diff.test.ts`, `surface-geoid-unification.test.ts`,
  `tile-cross-path-invariants.test.ts`.
- **Append, never rewrite.** Supersede instead of editing decided records.

## Related docs

- [`docs/COORDINATES.md`](../COORDINATES.md) — the canonical coordinate-space
  contract (LL / MM / DLM / SP) and its five cross-path invariants. ADR-0001
  records *why* that contract exists; COORDINATES.md *is* the contract.
- [`docs/AGENTS.md`](../AGENTS.md) — index of the internal engineering docs.
- Root [`README.md`](../../README.md) — language overview, architecture diagram,
  vector-tile pipeline.

# ADR-0003: Shader DSL single-emit + PROJECTIONS table as source of truth

Status: Accepted
Date: 2026-06-02

## Decision

Two coupled decisions:

1. **Single-emit shaders.** All WGSL the engine runs is _emitted_ from an
   in-house TypeScript DSL under `runtime/src/engine/shader-dsl/`. There is one
   DSL source per render surface — `shaders/polygon.ts`, `shaders/line.ts`,
   `shaders/point.ts`, `shaders/raster.ts` (plus `sdf.ts` / `log-depth.ts` /
   `ecef.ts` helper modules) — and they all share **one projection graph**,
   `shaders/projections.ts`, which authors `project` / `project_geom` /
   `flat_rel` / `needs_backface_cull` / `rim_alpha` once. The live GPU consumes
   the emitted strings directly: each renderer calls `device.createShaderModule`
   with `emit*Wgsl(...)` (`renderer.ts:82`, `line-renderer.ts:213`,
   `point-renderer.ts:107`, `raster-renderer.ts:110`).

2. **PROJECTIONS table is the single authority.** Everything that varies per
   projection type — `projType`, `cullThreshold`, `rimThreshold`, `worldCopies`,
   `worldBand`, and the boolean predicates `isFlat` / `isSeam` / `isCylindrical`
   / `isGlobe` / `periodic` — lives as one row in
   `runtime/src/engine/projection/projections-table.ts`
   (`PROJECTIONS`, lines 87–96). The shader dispatch ladder, the CPU mirror, the
   world-copy enumeration, and the tile-selection routing all **derive from**
   that table; none of them re-encode the data.

The two are joined at `projections.ts:32`, where the DSL imports `PROJECTIONS`
and generates the forward-dispatch ladder from it.

## Context

The recurring root cause across the projection audits was an **authority
inversion**: the `projType ↔ name ↔ capability` relationship was hand-encoded in
~3 representations (the render-loop name→int map, VTR's int→name array, and
inline name→int collapses in tile selection), and the per-projection cull / rim
thresholds were hand-written in three live runtime copies (the WGSL
`needs_backface_cull` + `rim_alpha`, the inline raster ladder, and the CPU
mirror). A "table" existed but was **pinned to** those scattered literals rather
than being their source — see the header of `projections-table.ts` (lines 1–21),
which describes the "authority flip, P1".

The discriminating evidence is recorded in `projection-threshold-drift.test.ts`
(lines 12–15): before the table became authority, mutating a single cull literal
in the WGSL string and running the whole suite stayed **green** — nothing pinned
the emitted WGSL to anything.

On the shader side, the same class held for math: the GPU WGSL and the f64 CPU
mirror (`projection-wgsl-mirror.ts`) were independently hand-maintained and could
silently diverge.

## Architecture

```
  projections-table.ts                          (DATA — single authority)
  ┌─────────────────────────────────────────┐
  │ PROJECTIONS: ProjectionRecord[]          │
  │   index == projType == proj_params.x     │
  │   { name, cullThreshold, worldCopies,    │
  │     worldBand, isFlat/isSeam/isCylindrical/
  │     isGlobe/periodic, ... }              │
  └─────────────────────────────────────────┘
        │ import + derive
        ├──────────────────────────────┬──────────────────────────────┐
        ▼                              ▼                              ▼
  shader-dsl/shaders/            derived predicates            CPU / tile-select
  projections.ts                 (same file):                  consumers via
  ┌──────────────────────┐       worldCopiesFor               gpu-shared re-export
  │ project / project_geom│      enumerateWorldCopies          (camera, tiles-sse,
  │ flat_rel              │      routeToSphereSelector          vector-tile-renderer)
  │ needs_backface_cull   │      promotesToGlobeWhenTilted
  │ rim_alpha             │      worldBandForProjType
  │ emitForwardLadder ────┼─ generated from PROJECTIONS order
  └──────────┬───────────┘
             │ PROJECTION_WGSL_CONSTS / _FNS  +  cpu-f64 lowering
   ┌─────────┴──────────────────────────────┐
   ▼                                          ▼
  per-surface DSL                          cpu-projections.ts
  polygon.ts / line.ts / point.ts /        (generated f64 mirror —
  raster.ts → emit*Wgsl(pickEnabled)        replaces the deleted
   │                                         projection-wgsl-mirror.ts)
   ▼
  device.createShaderModule({ code })       ← the LIVE GPU runs this
```

### How a projection's data reaches the GPU

`projections.ts` does not hard-code thresholds. It looks them up:

```ts
const AZI_CULL = byName('azimuthal_equidistant').cullThreshold as number // -0.85
const STEREO_CULL = byName('stereographic').cullThreshold as number // -0.8
```

and it generates the forward-projection dispatch ladder straight from table
order (`projections.ts:238–257`):

```ts
const FLAT = PROJECTIONS.filter((p) => !p.isGlobe) // projType 0..6
function emitForwardLadder(b, t, lon, lat, clon, clat) {
  // if (t < 0.5) … elif (t < 1.5) … else …  — one arm per FLAT row, in order
}
```

Because `array index == projType == proj_params.x` (the wire value the shaders
read), adding a row to `PROJECTIONS` extends both the WGSL ladder and the f64 CPU
ladder automatically, and the cull/rim thresholds it carries cannot drift from
the dispatch that uses them.

### Shared projection entry points

The per-surface shaders never re-derive projection math; they `callFn` the
shared graph. For example the polygon flat-non-Mercator arm
(`polygon.ts`, `emitPolygonProjectionLadder`) calls `flat_rel`, the line shader's
`finalizeCorner` (`line.ts:234`) calls `flat_rel`, and both the polygon fragment
discards (`polygon.ts`, `polygonCosCFragment`) and the line fragment
(`line.ts`, `computeLineColor`) call `needs_backface_cull` / `rim_alpha`. One
behavioural change to a projection touches exactly one DSL function.

## Consequences

### A projection change is one table row + one DSL branch

To add or alter a projection:

- edit/insert the row in `PROJECTIONS` (`projections-table.ts`), and
- add/adjust its forward in `forwardCall` (`projections.ts:225`) plus any
  per-form world-copy unwrap branch in `project_geom`.

The derived predicates (`worldCopiesFor`, `enumerateWorldCopies`,
`routeToSphereSelector`, `promotesToGlobeWhenTilted`, `worldBandForProjType`),
the name↔int maps (`PROJECTION_NAME_TO_TYPE`, `SELECTOR_PROJ_NAMES`), and the CPU
mirror all follow without separate edits.

The table also makes latent behaviour gaps _explicit_ rather than hidden. The
clearest example is `promotesToGlobeWhenTilted` vs `routeToSphereSelector`
(`projections-table.ts:125–146`): oblique_mercator (6) sphere-_routes_ its tiles
but is _excluded_ from globe promotion (it is cylindrical), so at pitch > 0 it
keeps a flat MVP while its tiles come from the sphere selector. The difference
between those two table-derived predicates _is_ the bug, written down.

### Guard rails

Three gates keep the single-emit property honest:

| Gate                | File                                              | What it pins                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Byte-drift snapshot | `shader-dsl/shaders/polygon-variant-diff.test.ts` | The polygon composer's emitted WGSL is compared byte-equal against committed snapshots under `__polygon-variant-snapshots__/` (≥8 fixtures). An intentional emit change must be paired with `bun scripts/capture-polygon-snapshots.ts` and a snapshot re-commit. |
| Threshold drift     | `projection/projection-threshold-drift.test.ts`   | Parses the cull `select()` and rim `smoothstep()` literals back out of the _emitted_ `WGSL_PROJECTION_FNS` and asserts they equal the `PROJECTIONS` rows. Mutating either the table or any live copy turns it red.                                               |
| CPU↔GPU parity      | `playground/e2e/_shader-math-parity.spec.ts`      | Executes the real emitted `WGSL_PROJECTION_FNS` on a WebGPU device and checks the result against the cpu-f64 lowering generated from the same graph.                                                                                                             |

The byte-drift gate is intentionally _byte-equal, not AST-equivalent_: a legacy-
vs-DSL structural diff would need a WGSL AST differ; the pixel survey + CI render
gate validate the _semantic_ legacy ≡ DSL equivalence end-to-end, and the
snapshot gate sits one level above to pin per-commit emit stability
(`polygon-variant-diff.test.ts:14–24`).

### Migration is complete for polygon; staged for the rest

The polygon surface migrated fully off the legacy hand-written WGSL template:
`render/renderer-shaders.ts` (`POLYGON_SHADER_SOURCE`, 826 LOC) was **deleted**
and the live polygon pipeline now builds from `emitPolygonWgsl`. The projection
_block_ every surface inlines (`WGSL_PROJECTION_CONSTS` / `_FNS`) is DSL-emitted
for all of polygon / line / point / raster — `shaders/projection.ts` is now a
thin re-export of the DSL output (`projection.ts:31–34`). The line, point, and
raster shaders still author their _surface-specific_ bodies as hand-WGSL strings
that prepend the shared emitted projection block (see `emitLineWgsl`,
`line.ts:1105`); converting those bodies to full DSL modules is tracked
separately (`docs/shader-dsl/PHASE-3-SCOPE.md`).

### Cost

- The DSL is engine-internal infrastructure (the IR in
  `shader-dsl/core/`, the WGSL backend, the CPU backend). New contributors author
  shaders against a builder API, not raw WGSL.
- Emit happens at module build / shader-module creation time, not per frame; the
  emitted string is handed to `createShaderModule` once per pipeline (and once
  more on a pick-variant rebuild).

## References

- `runtime/src/engine/projection/projections-table.ts` — `PROJECTIONS` (87–96),
  derived predicates (98–159), name maps (187–197).
- `runtime/src/engine/shader-dsl/shaders/projections.ts` — shared graph;
  threshold lookups (49–56), generated forward ladder (222–257), GPU emit
  (433–441).
- `runtime/src/engine/shader-dsl/shaders/polygon.ts` — `emitPolygonProjectionLadder`,
  `polygonCosCFragment`; the shared projType ladder dedup (200–294).
- `runtime/src/engine/shader-dsl/shaders/line.ts` — `finalizeCorner` (234),
  `computeLineColor`, `emitLineWgsl` (1105).
- `runtime/src/engine/shaders/projection.ts` — DSL re-export shim (31–34).
- Gates: `polygon-variant-diff.test.ts`, `projection-threshold-drift.test.ts`,
  `playground/e2e/_shader-math-parity.spec.ts`.

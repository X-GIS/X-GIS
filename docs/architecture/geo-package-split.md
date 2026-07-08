# @xgis/engine → @xgis/geo — extracting the shared cartography math

> Engineering plan for the **Camera generic-split** line of #781 (the "engine is NOT
> content-blind" epic). The engine's charter is a content-blind GPU / render substrate — a game
> built on it (the shader-DSL examples: Mandelbrot, ocean, raymarch) carries zero geographic
> content. Yet a full projection stack lives in `engine/src/projection/` and leaks out through the
> engine barrel (`engine/src/index.ts:16-25`). This plan removes geo from the engine **entirely**,
> splitting that subtree three ways: **shared cartography math → a new `@xgis/geo`** (both
> `@xgis/data` and `@xgis/map` consume it, and `data` sits below `map`), **map-only camera /
> interaction → `@xgis/map`**, **generic 4×4 matrix ops → `@xgis/shared`**. Companion to
> `engine-content-split.md` and `package-responsibilities.md`; it **refines** that plan's
> "MAP projections (mercator/globe/azimuthal) → @xgis/map" line, which did not account for
> `@xgis/data`'s dependency on the same primitives. Claims grounded in `file:line`.

## 1. Why the engine must be geo-free

Does the engine need geo? **No.** The engine's charter (`engine/src/index.ts:1`) is
"content-blind GPU/RHI machinery," benchmarked against Unreal / three.js, not a map library. The
shader-DSL examples that run on it — Mandelbrot, plasma, raymarch, ocean — use zero geographic
content. A game built on the engine needs cameras, matrices, passes, shaders; it never needs
Mercator, tiles, or Natural Earth.

The tree already agrees: the engine core is geo-free **except** the mis-placed
`engine/src/projection/` subtree. That subtree is reached from outside `projection/` through
exactly one file — the public barrel `engine/src/index.ts:16-25`
(`export * from './projection/projection'` … `'./projection/camera'`). Nothing in `engine/src/gpu/`,
`engine/src/render/`, or `engine/src/shaders/` imports it. (`frame-arena.ts` and `projection-token.ts`
match a `mercator` text search only in comments — the token is a content-blind opaque handle, no geo
math.)

So the option first floated — "keep the shared geo in the engine" — is **wrong** and is retracted.
Geo leaves the engine completely.

## 2. The constraint the original split missed

`engine-content-split.md` routed "MAP projections" to `@xgis/map`. But the projection primitives are
not map-only. **Both** packages import the same helpers from the engine barrel:

- `@xgis/data` (tile selection, `globe-visible-tiles.ts`, sources) imports `worldCopiesFor`,
  `TILE_PX`, `mercatorYToLat`, `MERCATOR_LAT_LIMIT`, `lonLatToMercator`, `PROJECTION_NAME_TO_TYPE`,
  `EARTH_R`, `buildGlobeMatrix`, `unprojectGlobe`, `worldBandForProjType`, `Projection`.
- `@xgis/map` (20+ files: renderers, camera-controller, packers) imports the same set.

`@xgis/data` sits **below** `@xgis/map` (`map` depends on `data`, never the reverse). If the shared
projection math moved to `@xgis/map`, `data` could never import it. Therefore the shared geo
primitives need a home **at or below `data`** — and, per §1, that home cannot be the engine.

That home is a new package: **`@xgis/geo`**, a pure cartography / projection library depending only
on `@xgis/shared`. Both `data` and `map` import from it; the engine never does.

> **Two sub-map leaks fixed first (prerequisites, already shipped).** Before geo can leave the
> engine, the two sub-map packages holding the geo `Camera` **type** had to stop referencing it:
> **PR #887** relocated the `FrameContext` / `FrameUniform` render-loop state out of
> `@xgis/rhi-webgpu` into `@xgis/map`; **PR #889** replaced `@xgis/data`'s `import type { Camera }`
> with a local `TileSelectionCamera` interface (`data/src/tile-select-types.ts`).

## 3. The three-way split

```
  @xgis/shared            @xgis/rhi   @xgis/shader-dsl        (bedrock, zero-dep)
  math · EARTH · ECEF          │            │
  + generic mat4 ops ◄──┐      ▼            ▼
        │               │  ┌───────────────────────────────┐
        │               │  │        @xgis/engine           │  content-BLIND
        │               │  │  RHI · device/buffer/pipe ·   │  (geo REMOVED)
        │               │  │  render-graph · frame loop ·  │
        │               │  │  compute · capability gates   │
        │               │  └───────────────────────────────┘
        ▼               │
  ┌───────────────────────────────┐        @xgis/compiler
  │        @xgis/geo  (NEW)        │  ← projection.ts · projections-table.ts
  │  pure cartography / projection │    globe.ts · world-scale.ts
  │  deps: @xgis/shared ONLY       │
  └───────────────┬───────────────┘
                  ▼
  ┌───────────────────────────────┐
  │          @xgis/data           │   → @xgis/geo   (no more engine geo import)
  └───────────────┬───────────────┘
                  ▼
  ┌───────────────────────────────┐
  │           @xgis/map           │   → @xgis/geo + @xgis/engine
  │  Camera · view-matrix ·       │     (Camera class + view/interaction geo
  │  globe-anchor · unproject     │      moved here from the engine)
  └───────────────────────────────┘
```

`@xgis/geo` and `@xgis/engine` become **siblings** on `@xgis/shared`. `map` depends on both; `data`
depends on `geo` only. The engine sits in no geo import path.

## 4. File-by-file destinations

`engine/src/projection/*` + `engine/src/gpu/world-scale.ts`:

| File                     | Destination      | Consumers     | Rationale                                                                                                                                                                                                                                                  |
| ------------------------ | ---------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projection.ts`          | **@xgis/geo**    | data + map    | Mercator + projection library; pure geo, needs only `EARTH`.                                                                                                                                                                                               |
| `projections-table.ts`   | **@xgis/geo**    | data + map    | `PROJECTIONS` registry + projType predicates. Geo SoT.                                                                                                                                                                                                     |
| `globe.ts`               | **@xgis/geo**    | data + map    | Sphere math: `buildGlobeMatrix`, `unprojectGlobe`, `EARTH_R`, `globeForward/Inverse`.                                                                                                                                                                      |
| `gpu/world-scale.ts`     | **@xgis/geo**    | data + map    | `WORLD_MERC`, `TILE_PX` — Web-Mercator constants, not GPU state.                                                                                                                                                                                           |
| `camera-helpers.ts`      | **split**        | geo + map     | mat4 ops (`mul4`/`mulVec4`/`perspectiveMatrix`/`invert4x4`) → **@xgis/shared**; Snyder inverses (`invOrthographic`/`invAzimuthalEquidistant`/`invStereographic`), `discAnchorFor`, `convergeFlatAnchor`, `FlatAnchorCamera`, `DiscAnchor` → **@xgis/map**. |
| `camera.ts`              | **@xgis/map**    | map only      | The `Camera` state machine — Mercator-native, map-owned.                                                                                                                                                                                                   |
| `view-matrix.ts`         | **@xgis/map**    | map only      | Frame builders (`buildRTCMatrix`/`buildGlobeFrame`/`buildECEFFrameView`/`ecefCenterOf`/`ecefToENUOf`/`CameraView`); only external caller is `map/src/render/tile-selection-cache.ts`.                                                                      |
| `globe-anchor.ts`        | **@xgis/map**    | map only      | Pointer interaction (`zoomAtGlobeAnchored`, `panGlobeToScreenAnchor`).                                                                                                                                                                                     |
| `unproject.ts`           | **@xgis/map**    | map only      | Reached only through the `Camera` that owns it.                                                                                                                                                                                                            |
| `camera-world-copies.ts` | **@xgis/map**    | map only      | Drives `Camera.getVisibleWorldCopies`; no other caller.                                                                                                                                                                                                    |
| `ecef.ts`                | **@xgis/shared** | already there | Already a re-export shim of `@xgis/shared` (`export * from '@xgis/shared'`). Drop the shim; import ECEF direct.                                                                                                                                            |

## 5. The generic-matrix decision

The mat4 helpers (`mul4`, `mulVec4`, `perspectiveMatrix`, `invert4x4`) are content-blind and used by
`globe.ts` (→ geo), `view-matrix.ts` (→ map), and `data/src/globe-visible-tiles.ts` — the only
external consumer outside `projection/`. To keep **`@xgis/geo` dependent on only `@xgis/shared`** —
and to avoid a `geo → engine` edge — they land in **`@xgis/shared`**, the zero-dep bedrock where
`EARTH` and the ECEF helpers already live. Linear algebra belongs in the foundation, not in a
cartography package, and not in the engine (whose core does not use it: no `engine/src/**` file
outside `projection/` references these ops).

## 6. Sequencing — five behavior-preserving PRs

Each slice: move → repoint the barrel + consumers → `tsc` (via `bun run build`) → full `vitest` →
real-render DC=0 where a render path is touched. The engine→map import-edge ratchet stays 0.

- **3a — mat4 ops → `@xgis/shared`.** Extract the four matrix helpers from `camera-helpers.ts`.
  Small, foundational; one external consumer (`globe-visible-tiles`). Gate: build + vitest.
- **3b — create `@xgis/geo` + move the leaves `data` needs.** `projection.ts`,
  `projections-table.ts`, `world-scale.ts` → geo. New `package.json` / `tsconfig`; slot in the
  ordered build after `shared`, before `data`. Repoint `data` / `map` / `runtime` imports; drop from
  the engine barrel. Gate: build + vitest + DC=0.
- **3c — move `globe.ts` → geo.** Sphere / globe-matrix math. Repoint `data/globe-visible-tiles` +
  the map globe path. Gate: build + vitest + DC=0.
- **3d — move map-only geo → `@xgis/map`.** `camera.ts`, `view-matrix.ts`, camera-helpers geo,
  `globe-anchor.ts`, `unproject.ts`, `camera-world-copies.ts`. Repoint the ~90 `Camera` import sites
  (mostly tests) — the engine barrel's `export * from './projection/*'` lines are the single
  cutover point. Gate: build + full vitest + real-render DC=0.
- **3e — lock it.** A resident-content ratchet asserting `engine/src` has no
  `mercator`/`projection`/`globe`/`Camera` symbols; fix any `frame-context` / `projection-token`
  residue. Gate: ratchet green in CI.

## 7. Risks & open classifications

- **`view-matrix` ↔ `camera-helpers` split precision.** `buildRTCMatrix` calls `perspectiveMatrix`
  / `mul4`; after 3a they import from `@xgis/shared`. Must stay byte-identical — verify with a
  real-render DC=0, not just `tsc`.
- **`camera-world-copies` / `unproject` ownership.** Classified map-only from current callers. If a
  `data` path reaches them, they promote to `@xgis/geo` instead. Re-verify at 3d.
- **`@xgis/geo` package plumbing.** Needs its own `package.json`, `tsconfig` with the `dist` path
  mapping other packages use, and a slot in the root `build` script's ordered chain.
- **No surviving `geo → engine` / `data → engine` edge.** After the move, verify with an import-edge
  check at 3e (matches the existing engine→map ratchet discipline).

## 8. Progress

| Slice                                                       | PR   | Status            |
| ----------------------------------------------------------- | ---- | ----------------- |
| 1 — `FrameContext`/`FrameUniform` out of `@xgis/rhi-webgpu` | #887 | ✅ merged-pending |
| 2 — `data` → local `TileSelectionCamera` interface          | #889 | ✅ merged-pending |
| 3a–3e — `@xgis/geo` extraction                              | —    | this plan         |

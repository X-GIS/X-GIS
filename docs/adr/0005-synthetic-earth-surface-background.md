# ADR-0005: Background fill as a synthetic earth-surface tile

Status: Accepted (Phase 2 PR 2c.3) — clear-value sub-decision SUPERSEDED by [ADR-0007](0007-defined-coverage-background-pass.md) (2026-06-02)
Date: 2026-05-28

## Context

A style can declare a `background { fill: ... }` block. The parsed colour
lands on `SceneCommands.background` (`runtime/src/engine/interpreter.ts:81-85`)
and must paint the earth's surface — the region "where the world is" — behind
every authored layer.

The original implementation was a standalone `BackgroundRenderer`: a
fullscreen-then-world-extent quad drawn in its own pre-pass with its own MVP
(iter-196 reduced it from fullscreen to a world-extent quad). That renderer
owned a _second_ projection path. On flat projections it painted a rectangle;
on sphere projections (orthographic / azimuthal / stereographic / globe) it
could not curve the fill to the disc/sphere silhouette, because its quad did
not flow through the same vertex shader the real tiles do. It was also a second
geoid to keep in sync, a second world-copy story, and a second set of seams to
debug.

Phase 2 migrated the polygon vertex pipeline to ECEF (`u.mvp_ecef` → `u.mvp`,
DSFUN-quantized ECEF-RTC vertices; see ADR/memory `ecef_tile_pipeline_phase2`).
Once polygons project through a single ECEF VS, the background fill can ride
the _same_ path instead of maintaining its own.

## Decision

The style `background-color` is rendered as a **synthetic earth-surface tile**
dispatched through the standard opaque polygon pipeline, and the standalone
`BackgroundRenderer` is deleted.

Concretely:

- **A synthetic `TileSource` backend** serves a single z=0 tile carrying a
  128×64 lat/lon mesh, packed in the same DSFUN quantized ECEF layout the
  polygon VS consumes —
  `runtime/src/data/sources/synthetic-earth-surface-backend.ts`. The backend
  registers under the stable source name `__synthetic_earth_surface__`
  (`SYNTHETIC_EARTH_SURFACE_SOURCE`, backend.ts:76) and emits its single tile
  immediately on `attach` (backend.ts:113-118) since the geometry is global and
  never refetched.

- **A synthetic `ShowCommand`** is prepended at the head of `commands.shows`
  (sort-order 0) so the fill paints behind every authored layer —
  `runtime/src/engine/map.ts:1821-1825`. The show is structurally identical to
  any compiler-emitted show (`buildSyntheticEarthSurfaceShow`,
  `runtime/src/engine/synthetic-earth-surface-show.ts:25-49`): it carries a
  `paintShapes.fill` constant the fragment shader reads, and resolves opacity /
  colour through the same `resolveShow` path as every other layer. No
  special-casing in the per-frame scheduler.

- **A dedicated `TileCatalog` + `VectorTileRenderer` pair** is wired for the
  synthetic source (`_installSyntheticEarthSurfaceSource`,
  `runtime/src/engine/map.ts:465-494`), reusing the host renderer's bind-group
  layout, palette atlas, sprite atlas, and ground/extruded/pattern pipelines.
  `setBackgroundFill(null)` tears this down, filters the synthetic show out of
  `showCommands`, and clears `_syntheticBackend` (map.ts:420-428); a later
  `setBackgroundFill(rgba)` re-installs it (map.ts:443-456).

- **The opaque-pass `clearValue` stays pure black** `{ r: 0, g: 0, b: 0, a: 1 }`
  (`runtime/src/engine/render/passes/opaque-pass.ts:96-100`). The synthetic fill
  only paints _inside_ the projected world band; the "no world here" region —
  above/below the ±85° Mercator world at z=0+pitch, or outside the disc/sphere
  silhouette — falls through to that black clear. This is the iter-196 MapLibre
  parity contract (opaque-pass.ts:86-95).

  > **SUPERSEDED by [ADR-0007](0007-defined-coverage-background-pass.md)
  > (2026-06-02).** The colour clear moved to a dedicated background pass
  > (bucket 0) and is now projType-aware: flat/cylindrical projections fill the
  > outside-band region with the style background-colour (no black void —
  > VISION §1, the user requirement); disc/globe keep defined black space. The
  > opaque first sub-pass now `loadOp:'load'`s the colour (depth/stencil/pick
  > clears stay). The inside-band synthetic earth-surface fill below is unchanged.

```
                       ┌─────────────────────────────────────────────┐
 style                 │ opaque pass                                 │
 background { fill }    │   clearValue = pure black {0,0,0,1}         │
        │              │   (shows through "no world here")           │
        ▼              │                                             │
 _backgroundColor      │   draw #0  synthetic earth-surface z=0 tile │ ← bg fill
 (map.ts:333)          │            (ECEF polygon VS, fill colour)   │
        │              │   draw #1  real tile A                      │
        ▼              │   draw #2  real tile B                      │
 SyntheticEarth-       │   ...      (paint on top, same VS)          │
 SurfaceBackend  ──────┴─────────────────────────────────────────────┘
 + buildSynthetic…Show
 prepended at shows[0]
```

## Why one mesh through the polygon VS

Because the synthetic tile is packed and dispatched exactly like a real ground
polygon, the background inherits — for free — the three properties the old
`BackgroundRenderer` had to re-implement:

1. **One geoid.** Vertices are quantized about the z=0 tile's WGS84-ellipsoid
   anchor `tileEcefCenter` via the shared tiler kernel `packECEFPolygonVertices`
   (backend.ts:27, 160-162, 239). The anchor latitude is the _decoded_ z=0
   tile-south `atan(sinh(-π))·180/π` (backend.ts:69), the same value the
   render-side per-tile `cam_ecef_off` reconstructs through `clampLat`
   (`vector-tile-renderer.ts:5032-5054`, cited in backend.ts:152-159), so the
   ECEF-RTC origins cancel bit-for-bit and the bg lands on the _same_ surface as
   real tiles. The whole globe is anchored about that single corner, giving a
   ~3 mm per-vertex fixed-point step against a ~1200 km grid cell (backend.ts:23-25).

2. **One projection forward.** The same polygon VS that projects real tiles
   (`emitPolygonProjectionLadder`,
   `runtime/src/engine/shader-dsl/shaders/polygon.ts`) projects the synthetic
   mesh, so the fill _curves naturally_ on sphere projections instead of being a
   flat strip — the design intent recorded in
   `runtime/src/engine/projection/earth-surface-fill.ts:1-22` and the projection
   AGENTS spec (`projection/AGENTS.md:45-54`).

3. **One world-copy story.** The flat-Mercator FILL arm re-adds the per-copy
   world offset so each world copy fills (PR #212 / `f87154a2`). Before the fix,
   the bg band (and all polygon fills) rendered on only one copy because the FILL
   arm algebraically cancelled `worldOff`; the synthetic tile would have left the
   off-copy hemisphere black. Gated by
   `runtime/src/engine/shader-dsl/shaders/polygon-worldcopy-fill.test.ts`.

## World band and polar caps

The mesh latitude band follows the projType, resolved from the authority table's
`worldBand` column (`runtime/src/engine/projection/projections-table.ts:80-95`,
`worldBandForProjType` at :157-159; `bandLatRange` consumes it in
`earth-surface-fill.ts:98-114`):

| projType                       | band               | lat extent                        |
| ------------------------------ | ------------------ | --------------------------------- |
| 0/1/6 merc·equi·obl            | `mercator-clamped` | ±`MERCATOR_LAT_LIMIT` (±85.0511°) |
| 2 natural_earth                | `natural-earth`    | ±90° (oval clip in VS)            |
| 3/4/5/7 ortho·azi·stereo·globe | `sphere-full`      | ±90° (poles)                      |

The band is fixed per backend instance; `XGISMap` re-installs the backend on a
projection change so the GPU vertex buffer refreshes (backend.ts:98-107).

Sphere-class bands have a wrinkle: their disc/sphere silhouette is the projection
of the _full_ ±90 grid, but the shared tiler kernel derives ECEF + `abs_lat` from
inverse-Mercator, which asymptotes at ±85.05 and can never represent ±90. A
straight kernel pack would leave a ~5° hole at each pole (the "black dots" of
userbug 09). So sphere bands take a **dual-encode** path
(`packECEFWithPolarCaps`, backend.ts:261-318):

- `|lat| ≤ ±85.05` rows use the Merc-clamped latitude + WGS84-ellipsoid forward
  — geoid-identical to ground tiles within the quant step.
- `|lat| > ±85.05` polar rows keep the **true** latitude and take
  `lonLatToECEF(lon, lat)` directly — real source-honest caps reaching ±90.

All vertices share one per-buffer symmetric half-range, so they decode through
the single `tile_dequant_scale` the GPU binds; the polar residual is only ~24 mm
larger than the ±85 band. The fragment-side `abs(abs_lat) > MERCATOR_LAT_LIMIT`
discard never trips at the cap because the VS writes the _clamped_ `abs_lat` to
the varying (`polygon.ts:92`, `abs_lat` location(2)) — only the per-vertex
_position_ attribute reaches the pole. Mercator (0/1/6) and natural_earth (2)
bands keep the unchanged canonical kernel path (`packKernelClamped`,
backend.ts:225-241) — byte-identical, zero behaviour change.

The mesh is 128×64 (not the 32×16 spec floor) so the disc rim is well under 1 px
on a full-canvas azimuthal disc and the polar-cap row sits at 87.19° instead of
85.05° (backend.ts:42-50). Cost is 8385 verts / 49152 indices for a single tile
drawn once.

## Consequences

- **Positive.** One geoid, one projection forward, one world-copy path shared
  between background and real tiles. `BackgroundRenderer` and its bundle-stats
  contribution are gone (`render-loop.ts:544-547`); the second projection path is
  retired. The fill curves correctly on every projection and reaches the poles on
  sphere projections.

- **Cost.** A synthetic source carries its own `TileCatalog` +
  `VectorTileRenderer` (map.ts:472-489). The sphere-band pack is a hand-inlined
  variant of the tiler kernel (`packECEFWithPolarCaps` vs the shared
  `packECEFPolygonVertices`) that must stay byte-compatible with
  `quantizeAxis` / the decode formula `q*scale - half`
  (backend.ts:209-218); a future kernel change must update both. The catalog
  `meta.bounds` stays ±85° (catalog tile-selection convention) even though a
  sphere-band mesh intentionally exceeds it (backend.ts:79-91).

- **Clear semantics** (SUPERSEDED — see [ADR-0007](0007-defined-coverage-background-pass.md)).
  Originally: the pure-black `clearValue` and its `isFirst ? clear : load`
  sub-pass discipline were pinned by `opaque-pass-clear-value.test.ts`, and the
  background was _additive on top_ of that black clear, not a replacement. As of
  ADR-0007 the whole-viewport clear is owned by the background pass, is
  projType-aware (flat → style bg, disc/globe → black), and the pin moved to
  `background-pass-clear-value.test.ts` (now a behavioural test of
  `backgroundClearValue`). The inside-band synthetic earth-surface fill is
  unchanged and still draws on top.

## References

- `runtime/src/data/sources/synthetic-earth-surface-backend.ts` — backend, mesh density, dual-encode pack
- `runtime/src/engine/projection/earth-surface-fill.ts` — mesh generator + world-band geometry
- `runtime/src/engine/projection/projections-table.ts` — `worldBand` authority column
- `runtime/src/engine/synthetic-earth-surface-show.ts` — synthetic ShowCommand wiring
- `runtime/src/engine/map.ts` — install / prepend / teardown lifecycle
- `runtime/src/engine/render/passes/opaque-pass.ts:86-100` — `clearValue` contract
- `runtime/src/engine/shader-dsl/shaders/polygon.ts` — `emitPolygonProjectionLadder` (the shared VS)
- `runtime/src/engine/projection/AGENTS.md:45-54` — earth-surface fill design spec

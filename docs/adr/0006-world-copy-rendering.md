# ADR-0006: Per-projType world-copy enumeration

Status: Accepted
Date: 2026-06-02

## Context

The map renders an infinitely repeating world in longitude: a viewport
straddling the antimeridian, or a low-zoom view that fits more than one
360° span on screen, must draw the same tile data shifted by integer
multiples of the world width. Each such shift is a **world copy**,
identified by an integer offset `wo` (0 = primary world, ±1 = the
neighbour to the east/west, …).

A world copy is not a single decision — it must be made **consistently
across three independent pipelines** for a frame to look right:

1. **Tile fetch / selection** — which tiles to request and upload.
2. **GPU fill / line / background draw** — how many times to draw each
   tile and at what x-shift.
3. **CPU label projection** — where to place each anchor's screen copy.

If any one of these enumerates a different copy set, copies desync:
fills appear without labels, labels float over empty ocean, or a whole
half-world goes blank. This ADR records how the copy set is derived
**per projType** so the three stay in lock-step.

The eight projTypes (see `projections-table.ts`, the single source of
truth) fall into three world-wrap classes:

| projType | name                | wrap class                |
| -------- | ------------------- | ------------------------- |
| 0        | mercator            | flat cylindrical (tight)  |
| 1        | equirectangular     | flat cylindrical (static) |
| 2        | natural_earth       | flat cylindrical (static) |
| 6        | oblique_mercator    | flat cylindrical (static) |
| 3        | orthographic        | single world `[0]`        |
| 4        | azimuthal_equidist. | single world `[0]`        |
| 5        | stereographic       | single world `[0]`        |
| 7        | globe               | single world `[0]`        |

## Decision

`Camera.getVisibleWorldCopies(canvasWidth, canvasHeight, dpr)`
(`runtime/src/engine/projection/camera.ts:870`) returns the copy set
for the current camera, branching on projType:

### Globe / azimuthal discs → `[0]`

Globe (7) and the azimuthal discs (orthographic 3 / azimuthal_equidistant
4 / stereographic 5) have no cylindrical longitude wrap — there is a
single visible hemisphere, not a repeating strip. They collapse to the
irreducible `SINGLE_WORLD = [0]` (`projections-table.ts:30`).

- Globe is handled first: `if (this.globeMode) return [0]`
  (`camera.ts:871`).
- The discs route through the `projType !== 0` branch
  (`camera.ts:879`), where `enumerateWorldCopies(projType, zoom)` is
  `false` because their `periodic` flag is `false`
  (`projections-table.ts:91-93`, `115-117`), so they return `[0]`.

### Periodic flat non-Mercator (equirect 1 / NE 2 / oblique 6) → static ±2, zoom-gated

These three are 2π-periodic in longitude (`periodic: true`,
`worldCopies: WORLD_COPIES`) but, unlike Mercator, do **not** use a
camera-derived range. They return the full static set the tile selector
emits:

```ts
// camera.ts:879-883
if (this.projType !== 0) {
  return enumerateWorldCopies(this.projType, this.zoom)
    ? worldCopiesFor(this.projType) // WORLD_COPIES = [-2,-1,0,1,2]
    : [0]
}
```

- `worldCopiesFor(projType)` is a pure table lookup returning
  `WORLD_COPIES = [-2, -1, 0, 1, 2]` for the periodic family
  (`projections-table.ts:27`, `107-109`).
- `enumerateWorldCopies(projType, zoom)` gates the set on
  `zoom <= WORLD_COPY_MAX_ZOOM` where `WORLD_COPY_MAX_ZOOM = 4`
  (`projections-table.ts:45`, `115-117`). Above z4 the neighbour copies
  project off-canvas, so the set collapses to `[0]`.

**Why static, not corner-derived?** The off-screen copies are
NDC-culled downstream by the label projector, so returning the full ±2
set keeps label copies **byte-identical** to the tile/fill copies — the
exact same `worldCopiesFor` / `enumerateWorldCopies` predicates drive
all three pipelines (see "Consumers" below). The rationale is recorded
inline at `camera.ts:872-878`.

### Mercator (0) → corner-unprojection tight range

Mercator is the only projType that computes a **tight, camera-derived**
copy range instead of a static set. Mercator is flat-selector-routed,
so its `periodic` flag is deliberately `false`
(`projections-table.ts:88`, comment at `73-76`) — it does **not** go
through `enumerateWorldCopies`. Instead `camera.ts:884-939`:

1. Builds the RTC matrix and uses `_mvpGeneration` as a per-frame
   matrix-identity cache key (`camera.ts:888-890`, cache fields at
   `868-869`); an unchanged camera re-uses the previous result.
2. Unprojects nine canvas samples (4 corners + 4 mid-edges + centre) to
   the z=0 plane (`camera.ts:896-906`). Mid-edge samples cover the
   extreme-pitch case where corner rays project behind the camera and
   return `null`.
3. Converts the resulting absolute longitude span to a `wo` range via
   `floor((lonMin+180)/360)` … `ceil((lonMax-180)/360)`, clamped to
   `[-2, 2]` (`camera.ts:926-929`).
4. Always includes `0` defensively (`camera.ts:934-936`).

So a Seoul-z15 view returns `[0]`, while a z0 antimeridian view returns
a small contiguous range like `[-1, 0]`.

## Consumers (the three pipelines that must agree)

| Pipeline      | Site                                                        | Copy source                                        |
| ------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Tile fetch    | `loader/tiles-sse.ts`, `data/tile-select*.ts`               | `worldCopiesFor` / `enumerateWorldCopies`          |
| GPU fill/line | `render/vector-tile-renderer.ts` (per-copy `worldOff` pack) | `ctx.visibleWorldCopies` / table predicates        |
| Raster draw   | `render/raster-renderer.ts:293-295`                         | `getVisibleWorldCopies` (Merc) else `[0]`          |
| CPU labels    | `render/passes/label-pass.ts:189-190`                       | `getVisibleWorldCopies` → `ctx.visibleWorldCopies` |

`label-pass.ts` calls `getVisibleWorldCopies` and writes the result to
`ctx.visibleWorldCopies` (`frame-context.ts:58-62`), which the
opaque/translucent polygon and line draw passes also read — so the
label fan-out and the GPU draw enumeration share one array per frame
(`label-pass.ts:186-190`).

## The gotcha: the flat-Mercator polygon FILL arm must explicitly ADD `world_off_m` (bug #212)

Enumerating the right copy set is necessary but not sufficient — each
GPU arm must also _honour_ the offset when it transforms a vertex.

The flat-Mercator polygon **FILL** arm
(`shader-dsl/shaders/polygon.ts`, `emitPolygonProjectionLadder`,
`proj_params.x < 0.5` branch, `polygon.ts:247-270`) originally let the
world-copy offset **algebraically cancel**, collapsing every `wo != 0`
copy onto the primary world. The arm computes:

```
p2d   = project(abs_lon, abs_lat)              // primary-world absolute X, worldOff-blind
rel2d = (p2d - tile_origin_merc) - cam_h - cam_l
```

With the CPU pack (`vector-tile-renderer.ts:5014-5018`):

```
tile_origin_merc.x = (tileWest + worldOff)·DEG2RAD·R
cam_h + cam_l      = camMercX - tileMercX        // camRelX, f64 cancellation
```

the `(tileWest + worldOff)` terms **cancel** in `rel2d.x`, so the
`wo=-1` copy drew at the same screen x as `wo=0`. Symptom (PR #212): at
OFM Bright mercator z0.5 lon 180 the left half (Asia, `wo=-1`) rendered
**only country-boundary lines on black** — no polygon fills, no
synthetic background band (the bg band flows through the same fill arm).

```
   BEFORE #212 (wo=-1 collapsed)        AFTER #212 (wo=-1 shifted)
  +-----------+-----------+            +-----------+-----------+
  |  lines    |  Americas |            |   Asia    |  Americas |
  |  only     |  filled   |            |  filled   |  filled   |
  | (black)   |  (wo=0)   |            | (wo=-1)   |  (wo=0)   |
  +-----------+-----------+            +-----------+-----------+
```

**Why the LINE arm survived.** The line shader's `finalize_corner`
(`shader-dsl/shaders/line.ts:234-247`) reconstructs absolute lon/lat
from the tile-local Mercator corner (`corner + tile_origin_merc`, which
_carries_ `worldOff`) and reprojects via `flat_rel` — so its offset was
never cancelled. The non-Mercator polygon sibling
(`polygon.ts:271-278`) likewise reprojects through `flat_rel`
(world-copy-aware via `tileRefLon`) and was unaffected.

**The fix** (`f87154a2`, PR #212) re-adds the per-copy shift the
non-Mercator sibling already applies, recovering the copy index from the
tile's displayed centre lon (`polygon.ts:263-270`):

```ts
const tileRefLon = (tile_origin_merc.x + 0.5·tile_extent_m) / (DEG2RAD·R)
const wo         = floor((tileRefLon + 180) / 360)
const world_off_m = wo·2π·EARTH_R
clip = mvp · vec4(rel2d.x + world_off_m, rel2d.y, z, 1)
```

It is camera-independent (the `worldOff` baked into `tile_origin_merc`
is an exact 360° multiple, so `floor((tileRefLon+180)/360)` recovers the
true copy index even at the ±180 antimeridian) and yields `wo=0 ⇒ +0`
for single-copy city views, keeping those fills byte-identical.

## Consequences

- World-copy enumeration is one table-driven decision
  (`projections-table.ts` PROJECTIONS rows + `worldCopiesFor` /
  `enumerateWorldCopies`), not scattered `projType === 0 || 1 || 2 || 6`
  literals.
- Mercator pays a nine-sample unproject per camera move (cached on
  `_mvpGeneration`) for a tight range; the periodic flat family takes
  the cheaper static ±2 set because its off-screen copies are NDC-culled
  anyway.
- Every GPU arm that consumes a per-copy `worldOff` must add the shift
  back **explicitly** if its math cancels `tile_origin_merc` against the
  camera offset — the fill arm proved this is easy to lose (#212). The
  line arm and the non-Mercator polygon arm avoid the trap by
  reconstructing absolute coords from worldOff-carrying tile-local
  metres.

## References

- `runtime/src/engine/projection/camera.ts:870-940` — `getVisibleWorldCopies`
- `runtime/src/engine/projection/projections-table.ts:27-30,45,87-117` —
  `WORLD_COPIES`, `SINGLE_WORLD`, `WORLD_COPY_MAX_ZOOM`, PROJECTIONS,
  `worldCopiesFor`, `enumerateWorldCopies`
- `runtime/src/engine/shader-dsl/shaders/polygon.ts:247-278` — fill ladder
  (Mercator `world_off_m` add + non-Merc `flat_rel`)
- `runtime/src/engine/shader-dsl/shaders/line.ts:234-247` — `finalize_corner`
- `runtime/src/engine/render/vector-tile-renderer.ts:5014-5018` — CPU pack
  (`tileMercX` includes `worldOff`; `camRelX` cancellation)
- `runtime/src/engine/render/passes/label-pass.ts:184-191` — label fan-out
- `runtime/src/engine/render/raster-renderer.ts:293-295` — raster copy set
- `runtime/src/engine/render/frame-context.ts:58-62` — `visibleWorldCopies`
- Tests: `projection/visible-world-copies.test.ts`,
  `engine/gpu/world-copy-gap.test.ts`, `projection/projections-table.test.ts`
- Commit `f87154a2` — fix(mercator): re-add world-copy offset to
  flat-Mercator polygon fill arm (#212)

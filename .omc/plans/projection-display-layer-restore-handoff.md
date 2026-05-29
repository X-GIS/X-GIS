# Handoff: Restore projection (2D flat vs 3D) as a display layer over ECEF data

Status: **PLANNED, not started.** Pick up in a fresh session.

## Problem (user-confirmed)

ECEF is the **data** coordinate system (how tile vertices are stored/processed) —
this unification is correct and stays. But the **display projection** (2D flat
Mercator/equirect/… vs 3D globe) is a *separate* concern that must be preserved.

Current bug: selecting Mercator (`proj: default`, projType=0, `globeMode=false`)
renders a **3D globe**, not a flat 2D map. Root cause: the vertex transform is
always `ECEF → ENU-rotation → perspective` (`getECEFFrameView`), which projects
the curved ECEF surface as a globe. `projType` only drives **fragment-side**
hemisphere-cull / rim-fade (`projections.ts:298-327`); it never changes the
**vertex** projection. There is currently no flat-projection vertex path.

A prior conclusion (PR #191) that "Mercator-plane retired = by-design" was
**WRONG** and must be reverted/replaced.

## Decisions already made (with the user)

1. **Reproject in the vertex shader** (keep data = ECEF; flatten per-vertex for
   flat projTypes). NOT a tiler change.
2. **Precision: ship f32 reprojection first** (Option P1). Accept ~1 m
   resolution from f32 `abs_lon`/`abs_lat` at extreme zoom; harden later only if
   jitter is observed. (Line vertices already carry precise tile-local Mercator
   DSFUN; polygon/point/raster carry f32 abs_lon/abs_lat.)

## What ALREADY EXISTS and gets reconnected (the retired path)

- `project(lon_deg, lat_deg, proj_params) -> vec2` WGSL fn (2D plane meters) and
  `project_geom` — `runtime/src/engine/shader-dsl/shaders/projections.ts:231,238`.
  Emitted via `PROJECTION_WGSL_FNS` (line/point already include it; polygon/raster
  currently pull only ECEF consts, so add the import).
- Flat 2D MVP: `camera.ts` `_buildRTCMatrix` (lines ~170-305), reachable via
  `getRTCMatrix` when `!globeMode`. Works in **camera-relative Mercator meters**.
- Mercator-RTC uniforms still present in shader structs: `cam_h`, `cam_l`
  (camera center, DSFUN hi/lo), `tile_origin_merc`.
- `render-loop.ts:141-155` already decides 3D-vs-flat: `globeMode = (projType===7)`,
  with azimuthal(3-5)+pitch>0 promoted to projType 7. Reuse this decision.

Projection table: `projections-table.ts:63-84`. 0=mercator,1=equirectangular,
2=natural_earth,3=orthographic,4=azimuthal_equidistant,5=stereographic,
6=oblique_mercator,7=globe. Flat = 0-6 (untilted); 3D = 7 + tilted azimuthal.

## Core mechanism (each shader vertex stage)

Branch on `proj_params.x` (projType — already in every shader's uniform):

```
if flat(projType):
    p2d  = project(abs_lon, abs_lat, proj_params)   // 2D plane meters (existing fn)
    rel  = vec3(p2d - cam_merc, z_lift)             // cam_merc = cam_h + cam_l (DSFUN)
    clip = mvp * vec4(rel, 1.0)                       // mvp = flat 2D MVP
else:
    clip = mvp * vec4(ecef_camera_relative, 1.0)     // current ECEF path (RTC fixes apply)
```

Renderer writes the **matching** `mvp` per projType (flat 2D MVP when flat, ECEF
MVP when 3D) so only the live branch's matrix matters. `abs_lon`/`abs_lat` already
present in all four shaders (used today for fragment cull). All four shaders carry
the same `cam_h`/`cam_l` slots (polygon/line/point/raster share the layout).

## Changes by file

1. **`runtime/src/engine/projection/camera.ts`** — add a projection-aware view
   selector, e.g. `getViewForProjection(projType, w, h, dpr)`: ECEF-MVP for 3D
   (7 / tilted azimuthal), flat 2D MVP (`_buildRTCMatrix`) for flat. Reuse the
   `render-loop.ts` 3D/flat decision.

2. **Renderers** (`vector-tile-renderer.ts`, `point-renderer.ts`,
   `raster-renderer.ts`; line shares VTR's group(0) uniform):
   - Write the projection-appropriate `mvp`.
   - For flat projTypes, write `cam_h`/`cam_l` = DSFUN split of
     `project(camLon, camLat)` (camera's projected position). Mercator path
     already computes cam_h/cam_l in Mercator meters (vector-tile-renderer.ts
     ~4841-4850); generalize the projected-center value to `project()` for the
     other flat types.

3. **Shaders** (`polygon.ts`, `line.ts`, `point.ts`, `raster.ts`): add the
   flat/3D VS branch. Import `project` (polygon/raster need the
   `PROJECTION_WGSL_FNS` include added; line/point already have it).
   - polygon `vs_main_ecef` + `vs_main_ecef_extruded`
   - line `vs_line` (note: line already has precise tile-local Mercator DSFUN
     `mx_h/my_h/mx_l/my_l` — for Mercator it can use that directly for higher
     precision instead of reprojecting from abs_lon/lat)
   - point `vs_point`
   - raster `vs_tile` (raster already reconstructs lon/latRad in-VS)

4. **Tests**:
   - DSL-emission guards: each VS contains the projType branch + a `project(` call.
   - SwiftShader render-position gate asserting **flatness** for Mercator: two
     points at the same latitude, far apart in longitude, land at the same
     screen-Y (a globe would curve them); a point far from center does not
     collapse toward a horizon. (Mirror `playground/e2e/_ecef-render-position.spec.ts`.)
   - Update polygon/raster DSL tests that currently assert `project_geom`/
     `proj_globe` are ABSENT from the VS (they'll be present again).

5. **Docs**: revert/replace the PR #191 "by-design frame split" conclusion in
   `camera.ts` comments + the #189 guard notes — the split is NOT the intended
   end state for flat projections.

## Phasing

1. Mercator (projType 0) end-to-end across all 4 shaders + flat MVP wiring →
   verify flat on mobile (`https://x-gis.github.io/X-GIS/play/`, dark demo).
2. Generalize to equirect / natural_earth / oblique (covered by `project()`);
   globe + tilted azimuthal unchanged.
3. Tests + doc cleanup.

## Watch out for

- **Uniform slot sharing**: polygon/line share VTR's group(0) slot (240 B,
  `cam_ecef_off` at f32 52/56 from the camera-relative RTC fix). Don't disturb
  that layout; `cam_h`/`cam_l` (f32 28-31) are the flat-path camera center.
- **The camera-relative ECEF RTC fixes (PRs #191, #192) are for the 3D/globe
  path and remain correct** — the flat path is additive, not a replacement.
- **z-lift / extrude**: flat path applies z_lift in the 2D plane's z; 3D path in
  ECEF z. Keep per-path.
- Precision: f32 `abs_lon`/`abs_lat` → ~1 m at high zoom (P1 accepted).

## Verification target

`proj: default` (Mercator) renders a **flat** map (Mapbox-style), pan/zoom behave
as a 2D map; `proj: globe` still renders the 3D sphere. Line ↔ fill stay aligned
in both (PR #192).

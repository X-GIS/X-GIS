# ADR-0002: Geoid split — vertices on WGS84 ellipsoid, camera basis on sphere

Status: Accepted (decision made autonomously during Phase 2 ECEF migration, kept).
Date: 2026-06-01.

## Context

X-GIS has two coordinate frames that both call themselves "ECEF":

| Frame         | Basis                                                       | Where it lives                                                 |
| ------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| **Ellipsoid** | WGS84: `a = 6378137`, `f = 1/298.257223563`, `E2 = 2f − f²` | tile vertices (`packECEFPolygonVertices`), tile-corner anchors |
| **Sphere**    | single radius `a = 6378137`, `E2 = 0`                       | the flat-MVP camera basis (`getECEFCenter`)                    |

These two frames differ by the polar flattening — about **21 km** at the
poles, and ~21.5 km at Tokyo's latitude (35.68°). `shared/src/ecef.ts:12-17`
spells this out: the ellipsoidal `lonLatToECEF` and the spherical
`lonLatToECEFSphere` share the same `a` but a non-zero vs. zero flattening,
"so the two coordinate frames differ by ~21 km of polar flattening."

The tiler picks the **ellipsoid** for vertices (3D-Tiles / Cesium parity —
the frame 3D Tiles 1.1 and Cesium World Terrain use). The flat-Mercator MVP
camera picks the **sphere** because the legacy 2D MVP is built on a spherical
Mercator basis (`WORLD_MERC = 2π × a`, single radius). That leaves a vertex
frame and a camera frame that disagree by the flattening.

The obvious "fix" is to put the camera on the ellipsoid too, so both frames
match. We tried it. It makes things worse for the flat MVP — see Decision.

## Decision

**Keep the split.** Tile vertices stay on the WGS84 ellipsoid; the flat-MVP
camera basis stays on the sphere.

- `Camera.getECEFCenter()` derives the camera anchor via
  `mercatorToECEFSphere` — the **sphere** variant — not `mercatorToECEF`.
  (`runtime/src/engine/projection/camera.ts:363-365`.)
- The tiler anchors each tile with WGS84 **ellipsoidal** math
  (`compiler/src/tiler/vector-tiler.ts:1647-1668`), matching
  `packECEFPolygonVertices` and `ecef.ts:tileEcefCenterFromMerc`
  byte-for-byte.

The vertex(ellipsoid) ↔ camera(sphere) "mismatch" is **by design**, and the
**#189 guard** pins it: the tiler's ellipsoid vertices stay within **≤1.5 px**
of the sphere camera anchor over one RTC tile extent, while keeping the
Mercator pixel-parity (AC1) the sphere basis guarantees.
(`camera.ts:352-362`.)

### Why not put the camera on the ellipsoid (D4)?

`camera.ts:354-358` records the measurement: building the camera anchor on
the WGS84 ellipsoid introduces a ~0.67 % (1 − E2 ≈ 0.99327) north-axis
compression that breaks the ECEF-MVP ↔ legacy-Mercator convergence the flat
path depends on. **Verified: switching the camera anchor to the ellipsoid
blows 19 of 24 cells past the 1.5 px gate** (`polygon-ecef-mvp-latitude-parity`,
AC2c.1.5). The gate is in
`runtime/src/engine/projection/polygon-ecef-mvp-latitude-parity.test.ts`.

So the "D4 globe-camera-on-ellipsoid" unification is **DEFERRED**. The trade is:

```
  re-deriving the #189 ≤1.5 px tolerance  (risk: 19/24 cells regress)
              vs.
  a sub-pixel fidelity gain on the flat MVP  (the residual is already < 1.5 px)
```

The risk dominates the gain. The future exit is Phase 2e (legacy
`project_geom` retirement): once the ellipsoid is the _only_ basis in use,
the sphere helpers can be collapsed back onto the ellipsoidal ones without a
parity gate to satisfy (`ecef.ts:109-111`).

## Consequence / gotcha — the globe 3D RTC arm MUST use the ellipsoid

The split above is safe for the **flat MVP** because the ≤1.5 px guard holds
over a tile extent. It is **NOT** automatically safe for the **true 3D globe**
(projType 7), because there the per-tile RTC offset is computed as a raw ECEF
delta, and a mixed basis bakes the full ~21 km gap into that delta.

The per-tile RTC offset packed in `vector-tile-renderer.ts` is:

```
  off = tileEcefCenter − cameraCenter
```

`tileEcefCenter` is on the ellipsoid (it has to be — it must match the
ellipsoid tile vertices). Therefore `cameraCenter` in _this_ subtraction MUST
**also** be computed on the **same ellipsoid**, or the ~21 km
ellipsoid−sphere discrepancy of the focus point survives the subtraction
instead of cancelling.

This was **bug #208** ("ellipsoid camera basis in globe RTC offset (z14
blank)", commit `5125c182`). The globe RTC arm computed `tileEcefCenter` on
the ellipsoid but `cameraCenter` on the sphere. The ~21 km offset is
invisible at low zoom but scales with zoom, because its per-pixel size is
metres-of-error / metres-per-pixel:

```
   z1.5  → 0.8 px    (sub-pixel — globe renders fine)
   z8    → 69  px    (partial — "half black")
   z14   → 4396 px   (the whole tile is thrown off-screen → blank)
```

Selection and upload were correct (`globeTilesSelected=20`,
`uploadQueued→0`, ~1406 draw calls) — the tiles were simply projected
thousands of pixels off a ~860 px viewport.

### The fix

Compute **both** `tileEcefCenter` and `cameraCenter` on the ellipsoid so
`off` is a pure ellipsoid-frame delta. The ~21 km absolute offset cancels in
the subtraction (tile and camera sit at nearly the same latitude at deep
zoom), leaving only the small, frame-consistent tile↔camera separation
(≈ km). The globe RTC arm therefore re-derives the prime-vertical radius `N`
inline for both the tile and the camera, using the same `E2`:

```
   E2 = (1/298.257223563) · (2 − 1/298.257223563)
   N(lat) = a / sqrt(1 − E2·sin²lat)
   off = N_tile·cos·… − N_cam·cos·…          (per axis, X/Y/Z)
```

Grounded at `vector-tile-renderer.ts:5032-5066` (the `cam_ecef_off` block,
DSFUN hi/lo packed at uniform floats 52-54 / 56-58). Note this arm does NOT
apply `worldOff` — ECEF is world-copy-independent on the sphere (the flat
`cam_h/cam_l` Mercator arm above it _does_ apply `worldOff`).

The residual after the fix is only the ellipsoid−sphere of the _local_ patch
(≈ tens of metres = a few px at z14), within the documented ECEF-MVP parity
tolerance.

### Why latitude matters (and the equator control)

The gap is purely a function of the flattening, so it is **zero at the
equator** (cos-of-flattening = full radius at lat 0). The globe always
rendered at the equator even at z14, even with the old mixed-basis bug —
matching the observed latitude dependence of the blank. This is the control
case in the regression gate.

## ASCII summary

```
  TILE VERTICES                         CAMERA BASIS
  WGS84 ellipsoid                       sphere (E2 = 0, radius a)
  packECEFPolygonVertices               getECEFCenter → mercatorToECEFSphere
        │                                     │
        │   ~21 km flattening gap             │
        │   (0 at equator, ~21.5 km @ Tokyo)  │
        ▼                                     ▼
  FLAT MVP (projType 0..6)
        off cancels at tile scale; #189 guard pins residual ≤ 1.5 px   ✓ kept
                                                                  D4 deferred

  GLOBE 3D (projType 7)
        off = tileEcefCenter(ellipsoid) − cameraCenter(???)
        ??? = sphere  → 21 km survives → 4396 px @ z14 → BLANK   ✗ bug #208
        ??? = ellipsoid → 21 km cancels → ≈ km residual          ✓ fixed
```

## Verification

- `runtime/src/engine/render/globe-ecef-frame-consistency.test.ts` — pins
  the CPU-side invariant the globe RTC arm relies on: mixed basis injects
  > 20 km (> 2000 px at z14) while same basis keeps `off` < 5 km
  > (< 1000 px at z14); also pins the monotonic zoom sweep (sub-pixel at z1.5,
  > tens of px at z8, thousands at z14) and the equator zero-gap control.
- `runtime/src/engine/projection/polygon-ecef-mvp-latitude-parity.test.ts` —
  the 1.5 px / 24-cell gate that rejects D4 (camera-on-ellipsoid).
- `compiler/src/tiler/ecef-precision-fuzz.test.ts` — the sub-mm DSFUN
  round-trip that forces the tiler anchor to stay ellipsoidal.

## References

- `shared/src/ecef.ts` — single source of truth for ECEF/WGS84 math;
  `lonLatToECEF` (ellipsoid) vs. `lonLatToECEFSphere` (sphere) + the ~21 km
  note (`ecef.ts:12-17`, `97-122`).
- `runtime/src/engine/projection/camera.ts:340-365` — `getECEFCenter` uses
  the sphere; the #189-guard "by design" rationale.
- `runtime/src/engine/render/vector-tile-renderer.ts:5032-5066` — the
  `cam_ecef_off` globe RTC arm, both terms on the ellipsoid.
- `compiler/src/tiler/vector-tiler.ts:1647-1668` — the ellipsoid tile-corner
  anchor that the camera offset must match.
- `docs/COORDINATES.md` — the LL/MM/DLM/SP convention this ADR sits beside.
- Commit `5125c182` (#208) — the globe-RTC ellipsoid-camera fix.

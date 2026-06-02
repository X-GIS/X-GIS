# ADR-0008: External-renderer (three.js) interop — contracts and current limits

Status: Accepted (documentation of current state — redesign step 0)
Date: 2026-06-02

## Context

A structural-soundness audit (`docs/redesign/VISION.md`) asked whether X-GIS's
camera + data are standard enough to interoperate with an external 3D library
such as three.js. The honest answer: the engine is interop-**capable** but
interop-**incomplete**. Three interpretations of "interop" were considered:

- **A — EXPORT**: drive an external three.js scene from X-GIS (its camera +
  world geometry).
- **B — COMPOSITE**: interleave three.js meshes into the X-GIS frame,
  depth-correctly.
- **C — SOUNDNESS-PROXY**: is the model standard *enough* (right-handed, metric
  world, separable view/projection) that *any* external lib could interop?

For a learning / portfolio project the deflated vision chose to **document the
integration contracts**, not build the interop feature (the accessors / readback
are additive and deferred unless a concrete requirement appears). This ADR is
that documentation — it records what an integrator can rely on and what they
cannot.

## What IS standard (an integrator can rely on)

- **Right-handed axes.** The ECEF basis is right-handed: X → (lon 0, lat 0),
  Y → east, Z → north pole; the globe `lookAt` is right-handed
  (`runtime/src/engine/projection/globe.ts`).
- **Readable camera state.** `getCameraState()` exposes
  lon/lat/zoom/bearing/pitch (`camera-controller.ts`), so an external lib can
  reconstruct *a* camera.
- **Premultiplied-alpha canvas**, single WebGPU context owned by X-GIS
  (`gpu.ts`).

## The three contracts (what an integrator CANNOT assume)

### 1. Camera output is a FUSED, RTC-relative MVP — no separable view/projection

Every camera matrix accessor returns a single pre-multiplied `P·T·R…` product,
and most are RTC (camera-relative), not a world-space view matrix. three.js (and
every standard 3D lib) consumes `matrixWorldInverse` (view) and
`projectionMatrix` (projection) as *separate* matrices in a world frame. X-GIS
ships only the product, and the only translate-included matrix (`getMatrix`) is
dead code.

- *Bridge if interop becomes a goal (additive, ~50 LOC, no hot-path change):*
  `Camera.getViewMatrix()` / `getProjectionMatrix()` returning the un-fused pair
  in the absolute sphere-ECEF frame — the fused builders already compute
  `P`, `T`, `Rx`, `Rz`, `Renu` separately (`camera.ts`), so this is "stop
  pre-multiplying and expose the two products". NOT built now.

### 2. Depth is LOGARITHMIC with a per-pixel `frag_depth` override

X-GIS writes `z_clip` via a log-depth formula with `fc = 1/log2(far+1)` and a
per-pixel `@builtin(frag_depth)` override (`shaders/log-depth.ts`), into a
`depth24plus-stencil8` buffer with `[0,1]` clip-z. A vanilla three.js mesh
writing linear/reverse-Z depth into this buffer will z-fight / sort wrong. For
COMPOSITE (interpretation B), three.js must be configured into the **identical**
log-depth formula, the same per-frame `fc`, and the same `[0,1]` clip-z. This is
**load-bearing for high-pitch precision — do NOT switch X-GIS off log-depth.**

- *Bridge:* expose `frame.logDepthFc` + `far` per frame and document the formula;
  configure `THREE.WebGPURenderer` with a matching log-depth. Doc-only here.

### 3. Geometry is split-float ECEF-RTC, on a SPHERE-vs-ELLIPSOID geoid

GPU vertices are DSFUN hi/lo split, ECEF-RTC relative to a per-tile/per-frame
centre (`shared/src/ecef.ts`) — meaningful only after subtracting the tile ECEF
origin in the vertex shader. There is no accessor yielding absolute (or
single-origin) world geometry; an external consumer would have to re-implement
the VS on the CPU. Worse, the geoid is **split** (see
[ADR-0002](0002-geoid-sphere-camera-ellipsoid-vertex.md)): the camera basis is a
**sphere** (E2 = 0), the tile vertices are the **WGS84 ellipsoid** (~21 km
apart), reconciled only within an RTC tile extent by a per-tile origin + a
`cos(lat)` altitude correction. So "this is ECEF" is ambiguous — it is
sphere-for-camera / ellipsoid-for-vertices. Handing absolute coords to three.js
without naming which geoid applies introduces a latitude-dependent error.

- *Bridge:* a geometry-readback path yielding absolute (or single-RTC-origin)
  ECEF f32 per layer — larger work, deferred. There is also no scene graph /
  transform-node hierarchy (transforms fold into per-draw uniforms), so a thin
  lon/lat/height → world-matrix anchor API would be needed to "parent" a 3D
  object to map space. Deferred.

## Decision

For the portfolio/technical-proof scope, **documenting these three contracts is
the deliverable**; no interop code is added. If interop becomes a real
requirement, the priority order is: (1) `getViewMatrix()`/`getProjectionMatrix()`
(satisfies EXPORT + SOUNDNESS-PROXY, cheapest), (2) the per-frame depth contract
accessor (satisfies COMPOSITE), (3) geometry readback + anchor API (largest,
last). Each is **additive** — none requires refactoring the render path.

## Consequences

- Interop is **possible with an adapter, not drop-in.** An integrator who reads
  this ADR can reconstruct a camera and match the depth contract; they cannot
  consume X-GIS's matrices or vertices directly.
- This is an honest **known-limitation** record, not a defect. The fused MVP +
  RTC split-float geometry + log-depth are deliberate precision/perf contracts,
  not accidents.
- No code change in this ADR.

## References

- `runtime/src/engine/projection/camera.ts` — fused MVP builders; dead `getMatrix`; the already-separable P/T/Rx/Rz/Renu
- `runtime/src/engine/shaders/log-depth.ts` — the log-depth contract (`fc`, formula, clip-z)
- `shared/src/ecef.ts` — DSFUN split-float ECEF-RTC geometry
- [ADR-0002](0002-geoid-sphere-camera-ellipsoid-vertex.md) — the sphere-camera / ellipsoid-vertex geoid split
- `docs/redesign/VISION.md` — §2 (cross-library grounding: MapLibre Transform/Painter, d3-geo, Cesium atmosphere)

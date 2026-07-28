# Projected gridded coverages (S-102 UTM cells)

**Status:** proposed · **Motivates:** every real NOAA S-102 cell · **Follows:** [ADR-0010](../../adr/0010-read-gridded-standards-in-place.md), the GAP-1 coverage path

## The problem, found by running it

The coverage path assumes a grid is **geographic and axis-aligned in lon/lat**. That
assumption is stamped in two places:

- `coverageFromGrids` hardcodes `crs: 'EPSG:4326'` (`data/src/coverage/format.ts`), and
- `CoverageRenderer.setCoverage` derives `covEdges` / `covGeo` as a lon/lat edge rectangle
  from `origin ± spacing/2` (`map/src/render/coverage-renderer.ts:163-176`), which the
  shader then `project()`s per fragment.

Every real NOAA S-102 cell violates it. A Chesapeake cell (`ed3.0.0/Mid_Atlantic/
Chesapeake_Bay/102US004MD1AF262297.h5`, 1663×2090, 4.0 MB) carries:

```
horizontalCRS  = 32618          # WGS 84 / UTM zone 18N — PROJECTED
gridOrigin     = [420767.84, 4183856.86]   # metres, not degrees
gridSpacing    = [16, 16]                  # metres
```

Read as-is, the grid is placed as if 420 767 **metres** were 420 767 **degrees** — not
off by a little, but off the planet. The reader now refuses such a cell loudly
(`assertGeographicCRS`, `data/src/hdf5/s102.ts`) rather than mis-rendering it, so today
the honest status is: **real S-102 cells read, and are then refused.** This design is how
they get drawn.

A projected cell is not an edge case to tolerate — NOAA publishes S-102 in UTM by
default, so "geographic only" means "no real S-102 at all".

## What the assumption really costs

A UTM grid is a rectangle **in UTM**. In lon/lat its edges curve (meridian convergence),
so there is no lon/lat rectangle that contains exactly the same cells. `covEdges` cannot
describe it, and neither can any corner-pin: fitting the four corners and interpolating
between them is precisely the affine approximation that misplaces the interior — the
class of shortcut CLAUDE.md's §12 architecture rule exists to stop, and doubly
unacceptable on soundings.

## The hook that decides this: the renderer already warps

The renderer does **not** draw a coverage as one quad. `vs_cov` emits a procedural
**64×64 mesh** (`COVERAGE_GRID_N`, `map/src/shaders/dsl/coverage-ramp.ts:100-133`) and
projects EVERY vertex through the general `project()`; the single-quad + baked
inverse-Mercator approach was already retired. Two lines carry the geographic
assumption, and only those two:

```
// vertex: the footprint is walked as a lon/lat rectangle
const lon = mix(edges.x, edges.z, u01);  const latDeg = mix(edges.y, edges.w, v01)
// fragment: UV is RECOVERED from the interpolated lon/lat
const uTex = pin.lon.sub(geo.x).div(geo.z)
```

The mesh is already a warp mesh. Nothing about it requires the footprint to be a lon/lat
rectangle — only those two lines assume it.

## Three candidate designs

### (A) Resample the grid into a geographic grid at read time

The handle that reaches the renderer is geographic, so the renderer is untouched. Costs
a resample of navigation data, plus a split where `valueAt` must read a different grid
than the one drawn.

### (B) Teach the FRAGMENT shader the CRS

Implement Transverse Mercator in WGSL and keep it in lockstep with the CPU's proj4.

**Rejected**, and not on effort: it creates a second authority for the same projection
math, on the GPU, disagreeing with the CPU by construction — this codebase's _dominant_
bug archetype (CLAUDE.md §12; the fill-vs-outline and camera-anchor histories), and it
would need its own df64 battery on Apple/Metal.

### (C) Reproject the MESH VERTICES on the CPU — **recommended**

Change exactly the two lines above:

- **Vertex lon/lat** comes from a CPU-built buffer: walk the grid in its OWN CRS and
  proj4-inverse each mesh vertex. That is `65 × 65 = 4 225` points per arm — computed
  once when the coverage is armed, not per frame, not per fragment.
- **Fragment UV** stops being recovered from lon/lat and is passed through as a varying.
  `u01/v01` already ARE the grid-space coordinates, so the UV becomes **exact for any
  CRS** instead of being inverted out of geography.

This is strictly better than (A) on the thing that matters:

- **No resample at all.** The texture stays the source grid; values are verbatim,
  positive-down, untouched. The whole "which grid does `valueAt` read" split disappears
  because there is only ever one grid.
- **(B)'s objection does not apply.** The projection runs on the CPU at mesh-build time.
  No projection math enters a shader, so no second authority is created.
- The renderer keeps its projection-generality and its globe path: per-vertex `project()`
  is unchanged, it just receives correct lon/lat.

**The residual error is mesh interpolation**, not resampling: between mesh vertices,
lon/lat is interpolated linearly while the true UTM→lon/lat relation is slightly
nonlinear. This is **the same error class the renderer already accepts today** for
geographic cells (its own comment: "fine tessellation makes the interpolated lon/lat
sub-texel for EVERY flat projection"), and it is closed-form boundable from mesh density
and cell span — an error-budget question with a number, not a fidelity loss. INC-3's gate
is that bound, measured, with `COVERAGE_GRID_N` raised if a real cell needs it.

## Reading depth precisely: soundings as LABELS, not colour

A colour ramp cannot be read to a metre, and that is not how a chart is meant to be read
— real charts print **sounding numerals**, thinned by scale. So the precise-value path is
not an API detail, it is on screen:

- The ramp gives the continuous picture.
- **Depth labels**, sampled from the ORIGINAL grid through `valueAt`, give the numbers,
  with density gated by zoom (the standard chart behaviour, and what S-101's own
  portrayal does via SNDFRM/SafetyDepth — GAP-2 INC-5).

Under (C) this is exact by construction: there is no resampled grid anywhere, so a label
cannot show an invented depth. (Under (A) it would have needed the readout/render split
described above — another reason (C) is the cleaner design.)

Sounding labels are their own increment (they need placement/declutter, not just a
value), listed below and deliberately not folded into the placement work.

### EPSG registration

`resolveEPSG` bundles two Korean codes plus proj4's builtins; 32618 is not among them.
UTM does not need a table: `EPSG:326xx` / `327xx` are WGS 84 / UTM zone xx N / S, each a
one-line proj string derivable from the code. One rule covers all 120 zones, so this is a
small addition to `epsg-defs.ts`, not a data dump.

## Increments

- [ ] **INC-1 — UTM in the EPSG registry.** Derive `326xx`/`327xx` in `epsg-defs.ts`.
      Gate: differential against pyproj on the existing cross-validation harness
      (`epsg-reprojection-crossval.test.ts`) for a spread of zones + both hemispheres.
      Independent of everything below.
- [ ] **INC-2 — `CoverageHandle` carries a real CRS.** Replace the hardcoded
      `crs: 'EPSG:4326'` with the cell's code; keep every geographic path byte-identical.
      Gate: existing coverage suites unchanged; a projected handle round-trips its code.
- [ ] **INC-3 — CPU-reprojected mesh vertices + UV as a varying.** The two-line change
      above, plus the per-arm vertex buffer. Gates: (a) a geographic cell is
      **byte-identical** through the new path — the procedural mesh and the CPU-built one
      must agree exactly at 4326, which is a real fail-before (no S-111 regression);
      (b) the mesh-interpolation error budget MEASURED against proj4 at mesh-interior
      points, with `COVERAGE_GRID_N` raised if a real cell exceeds sub-texel; (c) UV
      exactness — a synthetic projected grid's known cell must sample its own value;
      (d) `assertGeographicCRS` lifts only for codes that actually resolve.
- [ ] **INC-4 — the real-cell end-to-end gate + demo.** Live NOAA S-102 through the
      existing `/noaa/<bucket>/<key>` proxy route, viewport bbox from ①, refresh from ②.
      Gate: §5 render verification on a real GPU (this is the first increment with a
      render surface, so it cannot be signed off in a GPU-less environment).
- [ ] **INC-5 — sounding labels.** Depth numerals from `valueAt` over the ORIGINAL grid,
      thinned by zoom. Needs placement/declutter (the existing label pass), so it is its
      own increment rather than a rider on placement. This is what makes depth readable
      to a metre; the ramp alone never is.

## Scope honesty

- Horizontal placement only. The **vertical** datum story (decoupled, plural, positive-
  down — S-100 GAP-3's own scope note) is untouched and still open.
- (C) removes resampling from the design entirely, so there is no interpolation rule to
  choose per product — the texture is always the source grid.
- Non-UTM projected cells (Lambert, polar stereographic for Alaska) will read once
  `resolveEPSG` knows their codes; nothing in the design is UTM-specific beyond INC-1's
  derivation rule.
- This does not make X-GIS an ECDIS, and does not change the GAP-2 portrayal position.

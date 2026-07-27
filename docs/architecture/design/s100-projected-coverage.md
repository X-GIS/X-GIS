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

## Two candidate designs

### (A) Reproject the GRID at read time; render unchanged — **recommended**

Resample the projected grid onto a geographic grid at read time (proj4 is already a
runtime dependency of `@xgis/data`, used by `reprojectFeatureCollection`). The handle
that reaches the renderer is then geographic and axis-aligned, exactly as today, so
`CoverageRenderer`, the shader, the packers and the drape are **untouched**.

### (B) Teach the shader the grid's CRS

Keep the projected grid and make the fragment shader map a projected position back to a
cell — i.e. implement Transverse Mercator forward in WGSL and keep it in lockstep with
the CPU's proj4.

**(B) is rejected**, and not on effort: it creates a second authority for the same
projection math, on the GPU, disagreeing with the CPU by construction. That is this
codebase's _dominant_ bug archetype — two sibling paths that must agree diverging
sub-pixel until an over-zoom or high latitude amplifies it (CLAUDE.md §12; the fill-vs-
outline and camera-anchor histories). Paying that risk to avoid a CPU resample is a bad
trade, and it would need its own df64 battery on Apple/Metal.

## The design (A), and the one line that makes it honest

Resampling navigation data is the obvious objection. It is answered by **splitting the
render path from the readout path along a seam the codebase already draws**:

> `getCoverage(id).valueAt(...)` is documented as the value-readout **AUTHORITY** — "half-
> precision only ever affects the colour path (the r16float texture), never this readout"
> (`map/src/map.ts`).

Resampling gets exactly the same treatment: **it only ever affects the colour path.**

- **Render** samples the resampled geographic grid. Display fidelity is pixel-level; a
  resample below the pixel is invisible and harmless.
- **`valueAt(lon, lat)` reads the ORIGINAL projected grid**, by transforming the query
  point lon/lat → UTM (proj4, CPU) and indexing the untouched source cells. Exact
  soundings, verbatim, positive-down — no resampled value is ever returned as a value.

So `CoverageHandle` carries both: the resampled geographic grid for drawing, and the
source grid + its CRS for reading. That is one new field and one new query path, not a
new renderer.

### Resampling rule

**Nearest-neighbour, never bilinear.** Bilinear invents depths that were never sounded;
nearest preserves real values at the cost of ≤ half a cell of positional quantization.
For a 16 m cell that is ≤ 8 m of display placement error, well inside the S-102 cell
size and far outside the reach of the colour ramp. Bilinear is a legitimate choice for a
continuous scalar like water level (S-104) and must remain a per-product decision, not a
global default.

Output grid geometry: the geographic bounding box of the reprojected source corners **and
edge midpoints** (a curved edge's extreme is not always at a corner), at a spacing chosen
so the output has no fewer cells than the source along each axis — never upsampling into
false resolution, never silently decimating.

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
- [ ] **INC-3 — read-time resample + the readout split.** Nearest-neighbour reprojection
      to a geographic grid for the colour path; `valueAt` transforms the query and reads
      the SOURCE grid. Gates: (a) `valueAt` on a projected cell equals a GDAL/pyproj
      readout at sampled points — the exactness claim, differential not self-consistent;
      (b) a geographic cell is byte-identical through the new path (no regression for
      S-111); (c) the resampled grid's cell count ≥ source along both axes; (d) the
      refusal in `assertGeographicCRS` lifts only for codes that actually resolve.
- [ ] **INC-4 — the real-cell end-to-end gate + demo.** Live NOAA S-102 through the
      existing `/noaa/<bucket>/<key>` proxy route, viewport bbox from ①, refresh from ②.
      Gate: §5 render verification on a real GPU (this is the first increment with a
      render surface, so it cannot be signed off in a GPU-less environment).

## Scope honesty

- Horizontal placement only. The **vertical** datum story (decoupled, plural, positive-
  down — S-100 GAP-3's own scope note) is untouched and still open.
- Nearest-neighbour is chosen for bathymetry. S-104/S-111 may want bilinear; the
  resampler takes the rule as a parameter and the product layer picks it.
- Non-UTM projected cells (Lambert, polar stereographic for Alaska) will read once
  `resolveEPSG` knows their codes; nothing in the design is UTM-specific beyond INC-1's
  derivation rule.
- This does not make X-GIS an ECDIS, and does not change the GAP-2 portrayal position.

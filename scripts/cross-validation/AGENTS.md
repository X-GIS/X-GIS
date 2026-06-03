<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# scripts/cross-validation/

## Purpose
Python fixture generator that produces a committed JSON file consumed by the X-GIS TypeScript test suite to verify CPU-side projection, tile, and geometry math against independent reference implementations. Uses `pyproj` (EPSG transforms), `mercantile` (slippy-map tile math), and `shapely`/GEOS (geometry operations). The generator is intentionally a one-shot script, not a pytest suite. Output is written to `runtime/src/__tests__/cross-validation.fixture.json` and checked in. Managed with `uv`; no pip/venv workflow. The `.venv/` directory is present but must be excluded from all file searches.

## Key Files
| File | Description |
|------|-------------|
| `generate-fixtures.py` | Single-file fixture generator. Produces 10 sections: (1) Mercator forward 9×9 grid via EPSG:3857, (2) Mercator inverse round-trip, (3) tile math for 6 world cities at 8 zoom levels via mercantile, (4) polygon clip/containment vs shapely at z=3–14, (5) forward+inverse round-trips for 5 other projections (equirectangular, natural_earth/natearth2, orthographic, azimuthal_equidistant, stereographic) — oblique Mercator intentionally omitted, (6) per-tile country feature counts at z=2–3 from `playground/public/data/countries.geojson`, (7) per-country bounding boxes for France/Japan/Brazil/Australia/USA, (8) pipeline area samples (clip+triangulate area in Mercator m² for France/Japan/Brazil/Australia at z=3), (9) Douglas-Peucker simplification cases vs `shapely.simplify`, (10) EPSG input-reprojection samples for EPSG:4326/3857/5179/5186 (Korea UTM-K and Central Belt 2010 control points). Writes to `../../runtime/src/__tests__/cross-validation.fixture.json`. |
| `pyproject.toml` | `uv` project config (`xgis-cross-validation`). Dependencies: `pyproj>=3.6`, `mercantile>=1.2`, `shapely>=2.0`. Python ≥3.10. `tool.uv.package = false`. |
| `uv.lock` | Locked dependency tree for reproducible installs. Commit alongside `pyproject.toml` changes. |

## For AI Agents

### Working In This Directory
- **Never enter `.venv/`** — the Python virtualenv is managed exclusively by `uv` and must be excluded from all file searches and reads.
- To regenerate the fixture after an intentional formula change:
  ```
  cd scripts/cross-validation
  uv run generate-fixtures.py
  ```
  Then commit the updated `runtime/src/__tests__/cross-validation.fixture.json`.
- **Do NOT regenerate for bug fixes** — only regenerate when a projection/tile formula intentionally changes (e.g., switching Earth radius constant, adding a new projection). Unintentional fixture changes are regressions.
- `uv` is the only supported runner. Do not use `python`, `pip`, or `poetry`.
- The script reads `playground/public/data/countries.geojson` at runtime; ensure that file exists before regenerating.
- Oblique Mercator is intentionally absent from section 5: X-GIS uses a custom sphere-rotation-then-Mercator formula incompatible with pyproj's parameterization; it is verified by intra-repo CPU/WGSL consistency tests instead.
- EPSG:5179 and EPSG:5186 reference points (section 10) are NGII-published Korean control points; do not alter them without a primary-source citation.

### Testing Requirements
- After regenerating: run `bun run test` (or `bun scripts/precheck.ts`) to confirm `runtime/src/__tests__/cross-validation.test.ts` passes against the new fixture.
- The Python script itself has no pytest tests — it is a generator, not a test suite.
- CI runs the TypeScript tests; the fixture is the contract between this script and the TS suite.

### Common Patterns
- All projections use `R = 6378137` (matching `EARTH_RADIUS` in `runtime/src/engine/projection/projection.ts`).
- Sample grid: `LONS = [-170..170]` × `LATS = [-80..80]` (9×9, avoids Mercator pole singularity at ±85.05°).
- Pyproj transformers constructed with `always_xy=True` so longitude/easting is always the first argument.
- Section 8 area tolerance: skip country-tile intersections < 1 km² (`inter.area < 1e6` m²) to exclude slivers.
- Section 6 feature-count semantics: uses `intersection.area > 1e-12 deg²` (not `intersects`) to match X-GIS clipper semantics that emit triangles only for 2-D overlap, not shared-boundary touches.

## Dependencies

### Internal
- Reads: `playground/public/data/countries.geojson`
- Writes: `runtime/src/__tests__/cross-validation.fixture.json`
- Read by: `runtime/src/__tests__/cross-validation.test.ts`

### External
- `pyproj` ≥3.6 — EPSG projection transforms (wraps PROJ C library)
- `mercantile` ≥1.2 — canonical slippy-map tile math
- `shapely` ≥2.0 — GEOS-backed 2-D geometry (area, intersection, simplify, bounds)
- `uv` — Python package and virtualenv manager

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

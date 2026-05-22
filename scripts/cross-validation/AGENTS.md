<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# scripts/cross-validation/

## Purpose
Python harness that generates a committed JSON fixture used by the X-GIS TypeScript test suite to verify CPU-side projection and tile math against independent reference implementations. Uses `pyproj` (EPSG:3857 Mercator transforms), `mercantile` (slippy-map tile bounds and lon/lat ↔ tile-XY), and `shapely` (geometric operations). The fixture is written to `runtime/src/__tests__/cross-validation.fixture.json` and checked into the repo; TypeScript tests in that directory load it and compare X-GIS results against the reference values. Managed with `uv` (no pip/venv workflow).

## Key Files
| File | Description |
|------|-------------|
| `generate-fixtures.py` | Fixture generator. Produces projection samples (9×9 lon/lat grid → Mercator XY via pyproj), inverse Mercator samples, mercantile tile-bounds samples, and shapely geometry checks. Writes output to `runtime/src/__tests__/cross-validation.fixture.json`. |
| `pyproject.toml` | `uv` project config. Dependencies: `pyproj>=3.6`, `mercantile>=1.2`, `shapely>=2.0`. Python ≥3.10 required. |
| `uv.lock` | Locked dependency tree for reproducible installs. Commit alongside `pyproject.toml` changes. |

## For AI Agents

### Working In This Directory
- **Never enter `.venv/`** — the Python virtualenv contains ~167 dependency directories and must be excluded from all file searches and reads.
- To regenerate the fixture after an intentional projection/tile formula change:
  ```
  cd scripts/cross-validation
  uv run generate-fixtures.py
  ```
  Then commit the updated `runtime/src/__tests__/cross-validation.fixture.json`.
- Do NOT regenerate the fixture for bug fixes — only regenerate when the formula itself is intentionally changed (e.g., switching to a more accurate Mercator constant). Unintentional fixture changes are regressions.
- `uv` is the only supported runner. Do not use `python`, `pip`, or `poetry` — the `.venv` is managed exclusively by `uv`.

### Testing Requirements
- After regenerating: run `bun scripts/precheck.ts` to confirm `runtime/src/__tests__/cross-validation.test.ts` still passes against the new fixture.
- The Python script itself has no pytest tests — it is a generator, not a test suite.

### Common Patterns
- Reference constants used: `EPSG:4326 → EPSG:3857` via `pyproj.Transformer.from_crs(..., always_xy=True)`.
- Sample grid: 9×9 covering LONS `[-170..170]` × LATS `[-80..80]` (avoids Mercator pole singularity).
- Output path is resolved relative to `__file__`: `../../runtime/src/__tests__/cross-validation.fixture.json`.

## Dependencies

### Internal
- Writes to `runtime/src/__tests__/cross-validation.fixture.json`
- Read by `runtime/src/__tests__/cross-validation.test.ts`

### External
- `pyproj` ≥3.6 — EPSG:3857 projection transforms
- `mercantile` ≥1.2 — slippy-map tile math
- `shapely` ≥2.0 — geometric operations
- `uv` — Python package/virtualenv manager

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

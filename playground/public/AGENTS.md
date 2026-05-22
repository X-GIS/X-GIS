<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/public

## Purpose
Static assets served verbatim by Vite at the `/` root. Contains GeoJSON and XGT data files for demos and fixtures, a JSON style override for the isolated buildings-only comparison, and a sample Mapbox style with inline GeoJSON. These files are referenced directly by `.xgis` source files and e2e specs via absolute URL paths like `/data/countries.geojson`.

## Key Files
| File | Description |
|------|-------------|
| `liberty-buildings-only.json` | Stripped MapLibre Liberty style containing only background fill, flat building fill, and 3D building extrusion. Used by `compare.html` for isolated extrude pixel-diff comparison (iter-192). |
| `sample-mapbox-with-inline-geojson.json` | Sample Mapbox style with an inline GeoJSON source; used by the `import-mapbox-inline-geojson` demo and its e2e spec. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `data/` | GeoJSON and XGT geographic data assets for demos and fixtures (see `data/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Files here are served at their URL path relative to the Vite root. A file at `public/data/countries.geojson` is accessible at `https://localhost:3000/data/countries.geojson`.
- Do not add large binary files (images, PMTiles archives). Large GeoJSON files are acceptable.
- Style JSON files (`liberty-buildings-only.json`) are referenced by `compare-runner.ts` STYLES catalogue by path. If you rename a file, update the catalogue entry.

### Testing Requirements
- Assets are indirectly tested via e2e specs that load demos referencing them. No dedicated asset tests.

### Common Patterns
- GeoJSON assets follow the standard FeatureCollection format.
- `.xgt` files are X-GIS compiled tile format; they are referenced from `.xgis` source files.

## Dependencies

### Internal
- Referenced by `src/examples/*.xgis` source files and `src/compare-runner.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

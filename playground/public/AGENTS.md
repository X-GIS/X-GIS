<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# playground/public

## Purpose

Static assets served verbatim by Vite at the `/` root during local development and e2e runs. Contains the two top-level style JSON files used by the comparison harness and the inline-GeoJSON demo, plus the `data/` subtree of GeoJSON fixtures and Natural Earth datasets. Files here are referenced by `.xgis` source files and Playwright e2e specs via absolute URL paths such as `/data/countries.geojson`.

## Key Files

| File                                     | Description                                                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liberty-buildings-only.json`            | Stripped MapLibre Liberty style retaining only background fill, flat building fill, and 3D building extrusion. Referenced by `compare-runner.ts` STYLES catalogue for isolated extrude pixel-diff comparison. If renamed, update the catalogue entry. |
| `sample-mapbox-with-inline-geojson.json` | Sample Mapbox style with an inline GeoJSON source; loaded by the `import-mapbox-inline-geojson.xgis` demo and its e2e spec.                                                                                                                           |

The `data/` subdirectory holds the GeoJSON geographic assets. Note that `playground/public/data/*` is gitignored except an allow-list (see `.gitignore`): only the committed assets travel with the repo — Natural Earth **110m** layers (`ne_110m_{countries,ocean,land,coastline,rivers,lakes,populated_places}.geojson`), `countries.geojson`, `land.geojson`, and the small `fixture-*.geojson` files for isolated render/pipeline tests (triangle, point, line, line-join, square, antimeridian, mercator-clip, categorical, stress-many, points-pop, EPSG:5179 Seoul reprojection). Higher-resolution Natural Earth (`ne_10m_*` / `ne_50m_*`) and any `.xgt` tiles referenced by demos are gitignored bulk assets fetched/generated locally, not checked in.

### Fetching the bulk Natural Earth assets

```
bun run fetch:demo-data
```

73.8 MB across eight files, into `data/`, still gitignored afterwards. Thirteen demos need them — `physical-map-10m`, `physical-map-50m`, `rivers-10m`, `states-10m`, `states-provinces`, `layered-borders`, `night-map`, `water-hierarchy`, `populated-places`, `raster-overlay`, `zoom-lod` among them. Without the fetch those demos hang before `__xgisReady`: the dev server answers a missing `/data/*.geojson` with its HTML 404 page at **status 200**, so the source ingest rejects the body rather than seeing a clean 404.

The local names are **not** the upstream names — `ne_50m_rivers.geojson` is Natural Earth's `ne_50m_rivers_lake_centerlines`, `ne_50m_states.geojson` is `ne_50m_admin_1_states_provinces`. That mapping lives in `scripts/fetch-demo-data.ts` (`DEMO_ASSETS`) because it cannot be guessed, and `scripts/demo-data-coverage.test.ts` gates it: an asset a demo references must be either checked in or listed there, so a new demo cannot quietly depend on a file nobody can obtain.

Unlike the checked-in 110m files, the fetched copies are **raw upstream** — no property pruning. The 110m files were pruned per-file for git size (rivers keeps 7 of 35 keys; `countries` is a different vintage entirely, with 71 UPPERCASE keys), and that is not one reproducible recipe. It costs nothing here: of the demos that need these assets, all but two style by geometry alone, and the two that read a property (`admin`, in `states-10m` / `states-provinces`) find it upstream.

## For AI Agents

### Working In This Directory

- Files are served at their path relative to the Vite root; `public/data/foo.geojson` → `http://localhost:3000/data/foo.geojson`.
- Do not add large binary files (images, PMTiles archives). Large GeoJSON is acceptable.
- The two top-level JSON files are referenced by name in `src/compare-runner.ts`. Renaming either requires updating that catalogue entry.
- Fixture GeoJSONs live under `data/` and are named `fixture-<capability>.geojson` to match `src/examples/fixture-<capability>.xgis` and the corresponding e2e spec.

### Testing Requirements

- Assets are tested indirectly: style JSONs via e2e compare specs; fixture GeoJSONs via Playwright fixture and probe specs under `playground/e2e/`. No dedicated unit tests for assets themselves.

### Common Patterns

- GeoJSON assets follow RFC 7946 (WGS-84 coordinates, FeatureCollection wrapper).
- `.xgt` files are compiled X-GIS tile format; regenerate via the compiler CLI if the XGT format changes.

## Dependencies

### Internal

- Referenced by `playground/src/examples/*.xgis` source files and `playground/src/compare-runner.ts`.

### External

- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

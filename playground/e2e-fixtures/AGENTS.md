<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/e2e-fixtures

## Purpose
Crash-replay snapshots captured from the live X-GIS production site. Each JSON file records a page URL, User-Agent, and camera state at the moment a user-reported bug was observed. The `_snapshot-replay.spec.ts` and `_snapshot-from-paste.spec.ts` e2e specs load these files to reproduce the exact camera configuration and assert the engine does not crash or produce incorrect output.

## Key Files
| File | Description |
|------|-------------|
| `bug-snapshot.json` | Production crash snapshot: `https://x-gis.github.io/X-GIS/play/demo.html?id=osm_style#17.00/40.758/-73.986/45.0/80.2` (Manhattan z17, bearing 45°, pitch 80°). Schema v1: `schemaVersion`, `pageUrl`, `userAgent`, `camera {lon, lat, zoom, bearing, pitch}`. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- Add new snapshots here when a user reports a reproducible bug with a specific URL + camera state.
- Schema: `{ schemaVersion: 1, pageUrl: string, userAgent: string, camera: { lon, lat, zoom, bearing, pitch } }`.
- The `_snapshot-replay.spec.ts` spec reads all JSON files from this directory, reconstructs the camera hash, navigates to the equivalent local demo URL, and asserts `__xgisReady` + no console errors.
- `pageUrl` uses the production GH Pages URL; the spec rewrites it to `https://localhost:3000` for local replay.

### Testing Requirements
- Exercised by `../e2e/_snapshot-replay.spec.ts`.

### Common Patterns
- Filename convention: `bug-snapshot-<issue-slug>.json` for named bugs, `bug-snapshot.json` for the primary reproduction fixture.

## Dependencies

### Internal
- Consumed by `../e2e/_snapshot-replay.spec.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

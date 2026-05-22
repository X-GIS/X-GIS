<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/e2e/fixtures

## Purpose
Static test data consumed by e2e specs at test runtime. Currently contains camera-motion scenario JSON files used by performance and interaction tests that need realistic multi-second user trajectories (zoom-in, pitch transition, globe rotation, projection flip). Each scenario encodes a start camera state, end camera state, projection, easing, and duration; the `helpers/scenarios.ts` loader validates and parses them.

## Key Files
| File | Description |
|------|-------------|
| `scenarios/README.md` | Documents the scenario JSON schema and authoring guidelines. |
| `scenarios/seoul-zoomin.json` | Mercator zoom-in trajectory over Seoul (z8→z17, 6s ease-in-out). |
| `scenarios/manhattan-pitch.json` | Mercator pitch-up trajectory over Manhattan (p0→p60, 6s). |
| `scenarios/global-globe-rotation.json` | Globe projection rotation around the world meridian (6s linear). |
| `scenarios/arctic-projection-flip.json` | Equirectangular→orthographic projection-flip scenario over the Arctic. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `scenarios/` | Camera-motion scenario JSON files (one per named trajectory). |

## For AI Agents

### Working In This Directory
- Do not add binary files. All fixtures are JSON or plain text.
- Scenario JSON schema is validated by `helpers/scenarios.ts`; a malformed file throws at load time with a specific field error. The required fields are: `name` (string), `description` (string), `projection` (one of 8 valid values), `startCamera` and `endCamera` (objects with `lon`, `lat`, `zoom`, `pitch`, `bearing` as finite numbers), `durationMs` (positive number), `easing` (`linear` or `ease-in-out-cubic`).
- To add a new scenario: create `scenarios/<slug>.json`, add the slug to `listKnownScenarios()` in `helpers/scenarios.ts`, and write or extend a spec that calls `loadScenario('<slug>')`.
- Camera coordinates: `lon`/`lat` in WGS-84 degrees, `zoom` in X-GIS zoom level, `pitch` in degrees (0=top-down, 60=steep), `bearing` in degrees clockwise from north.

### Testing Requirements
- Scenario files are consumed by `helpers/scenarios.ts`; no direct test run from this directory.
- The schema validation in `loadScenario` is the test — a parse error means the JSON is malformed.

### Common Patterns
- Scenario slugs match the filename without extension: `loadScenario('seoul-zoomin')` reads `scenarios/seoul-zoomin.json`.
- Use the `ease-in-out-cubic` easing for realistic user-motion simulations; `linear` is for deterministic assertions where exact interpolation matters.

## Dependencies

### Internal
- Consumed by `../helpers/scenarios.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

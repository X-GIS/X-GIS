<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# playground/e2e/fixtures

## Purpose
Static test data consumed by Playwright e2e specs at runtime. Contains camera-motion scenario JSON files that encode realistic multi-second user trajectories (zoom-in, pitch transition, globe rotation, projection flip). Each scenario defines `startCamera`, `endCamera`, `projection`, `easing`, and `durationMs`. `playground/e2e/helpers/scenarios.ts` (committed) exposes `loadScenario(name)` to read+validate a scenario and `listKnownScenarios()`; rAF-paced interpolation and per-frame timing live in `helpers/natural-interaction.ts` (`runInteraction`). The `scenarios/` subdirectory holds all scenario data alongside a README that documents the schema.

## Key Files
| File | Description |
|------|-------------|
| `scenarios/README.md` | Schema reference, per-scenario descriptions, and Plan §8.5 notes on the consumer helper. |
| `scenarios/seoul-zoomin.json` | Mercator zoom-in over Seoul (z8→z16, 6 s ease-in-out-cubic). Baseline for OFM Bright tile cascade and label density. |
| `scenarios/manhattan-pitch.json` | High-pitch pan over Manhattan. Exercises fill-extrusion render budget and LOD swap at z=15 pitch=70. |
| `scenarios/global-globe-rotation.json` | Full 360° globe rotation. Drives sphere-cap tile selection, rim alpha fade, and antimeridian wrap. |
| `scenarios/arctic-projection-flip.json` | Camera over the north pole on equirectangular→orthographic flip. Tests low-zoom tile selector and polar-cap synthesis. |

## For AI Agents

### Working In This Directory
- All fixtures are JSON or plain text — no binary files.
- Scenario JSON fields: `name` (string), `description` (string), `projection` (one of 8 values: `mercator | globe | equirectangular | natural_earth | orthographic | azimuthal_equidistant | stereographic | oblique_mercator`), `startCamera`/`endCamera` (each with `lon`, `lat`, `zoom`, `pitch`, `bearing` as finite numbers), `durationMs` (positive number), `easing` (`linear` or `ease-in-out-cubic`).
- The consuming helper (`helpers/scenarios.ts`) validates schema at load time in `loadScenario`; a malformed file throws with a specific field error.
- To add a new scenario: create `scenarios/<slug>.json`, register the slug in `listKnownScenarios()` in `helpers/scenarios.ts`, and write or extend a spec calling `loadScenario('<slug>')`.
- Camera coords: `lon`/`lat` in WGS-84 degrees; `zoom` in X-GIS zoom level; `pitch` in degrees (0 = top-down, 85 = max); `bearing` clockwise from north.

### Testing Requirements
- No test runner executes directly from this directory; fixtures are consumed by e2e specs via `helpers/scenarios.ts`.
- Schema validation inside `loadScenario` is the effective guard — a parse error surfaces a malformed fixture immediately.

### Common Patterns
- Slug matches filename without extension: `loadScenario('seoul-zoomin')` reads `scenarios/seoul-zoomin.json`.
- Use `ease-in-out-cubic` for realistic user-motion simulations; use `linear` only when deterministic frame-by-frame assertions are required.

## Dependencies

### Internal
- Consumed by `../helpers/scenarios.ts` (`loadScenario` / `listKnownScenarios`).

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

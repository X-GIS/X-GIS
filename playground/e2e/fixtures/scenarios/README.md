# E2E Scenario Fixtures

Real-world camera motion scenarios for perf + visual regression
tests. Each JSON describes a smooth transition from `startCamera`
to `endCamera` over `durationMs`, with a named `easing` curve.

## Schema

```json
{
  "name": "string identifier (used as artifact filename prefix)",
  "description": "what this scenario exercises",
  "projection": "mercator | globe | equirectangular | natural_earth | orthographic | azimuthal_equidistant | stereographic | oblique_mercator",
  "startCamera": { "lon": -180..180, "lat": -90..90, "zoom": 0..22, "pitch": 0..85, "bearing": 0..360 },
  "endCamera":   { "lon": ..., "lat": ..., "zoom": ..., "pitch": ..., "bearing": ... },
  "durationMs": number (typical 3000..10000),
  "easing": "linear | ease-in-out-cubic"
}
```

## Available scenarios

* **seoul-zoomin** — Smooth zoom in over Seoul z=8→16. Baseline
  for OFM Bright tile cascade + label density.
* **manhattan-pitch** — High-pitch pan over Manhattan. Exercises
  fill-extrusion render budget + LOD swap at z=15 pitch=70.
* **global-globe-rotation** — Full 360° globe rotation. Sphere-cap
  tile selection + rim alpha fade + antimeridian wrap.
* **arctic-projection-flip** — Camera over north pole. Low-zoom
  tile selector + polar cap synthesis behaviour.

## Plan §8.5 — what consumes these

Future perf / visual specs read the JSON via a `runScenario(page,
name)` helper that:
1. Loads the page with `projection` query param.
2. Sets up startCamera.
3. Drives a rAF-paced interaction interpolating to endCamera over
   durationMs with the named easing curve.
4. Records per-frame timings via natural-interaction.ts helpers.
5. Emits a per-scenario REPORT.md row.

The loader (`loadScenario` / `listKnownScenarios`) is committed at
`playground/e2e/helpers/scenarios.ts`; the rAF-paced driving + timing
(steps 3–4) lives in `playground/e2e/helpers/natural-interaction.ts`
(`runInteraction`). The combined `runScenario` wrapper lands with the
consumer specs.

# OpenFreeMap / MapLibre style fixtures

These JSON files are committed snapshots of public Mapbox-spec
style.json documents. They are inputs for the converter coverage +
parity tests (`style-coverage-report.test.ts`,
`_style-parity-diff.spec.ts`). Committing them keeps vitest offline
and makes PR diffs reflect *our* converter changes rather than
upstream stylesheet drift.

## Refresh cadence

Manual, ad-hoc. Re-snapshot when:
- A converter change is expected to fix coverage on the current set
  and we want to lock the result in.
- An upstream provider lands a notable change (new layer types, new
  expressions, etc.) and we want our tests to reflect current reality.

## Commands

```bash
curl -sf https://demotiles.maplibre.org/style.json \
  > compiler/src/__tests__/fixtures/maplibre-demotiles.json
curl -sf https://tiles.openfreemap.org/styles/bright \
  > compiler/src/__tests__/fixtures/openfreemap-bright.json
curl -sf https://tiles.openfreemap.org/styles/liberty \
  > compiler/src/__tests__/fixtures/openfreemap-liberty.json
curl -sf https://tiles.openfreemap.org/styles/positron \
  > compiler/src/__tests__/fixtures/openfreemap-positron.json
```

After refresh, run vitest with `-u` to regenerate
`style-coverage-report.test.ts.snap`:

```bash
bun x vitest run compiler/src/__tests__/style-coverage-report.test.ts -u
```

Review the snapshot diff to confirm the changes are upstream-driven
and not a converter regression.

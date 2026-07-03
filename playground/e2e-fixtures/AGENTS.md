<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/e2e-fixtures

## Purpose

Static fixture data consumed by the Playwright e2e snapshot-replay suite. Each JSON file records a full engine state snapshot — camera, viewport/DPR, GPU tile cache contents, render-order trace, and canvas pixel hash — captured at the moment a user-reported bug was observed in the live playground. The three `_snapshot-*.spec.ts` specs in `../e2e/` use these fixtures (plus runtime capture) to reproduce bugs deterministically, verify the copy-button UI, and let engineers replay a pasted snapshot without modifying committed fixtures.

## Key Files

| File                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bug-snapshot.json` | Production crash snapshot: Manhattan z17 bearing 45° pitch 80° (`osm_style#17/40.758/-73.986/45.0/80.2`). Schema v1: `schemaVersion`, `pageUrl`, `userAgent`, `camera {lon,lat,zoom,bearing,pitch}`, `viewport {width,height,cssWidth,cssHeight,dpr}`, `pageViewport {width,height}`, `sources` (per-source `gpuCacheCount`/`pendingFetch`/`pendingUpload`/`tiles[]`), `renderOrder[]`, `pixelHash`, `pixelHashBy`. File is ~2 MB (full tile list for 340-tile GPU cache). |

## For AI Agents

### Working In This Directory

- Add a new JSON file here whenever a user reports a reproducible bug with a specific URL + camera state; use the filename convention `bug-snapshot-<issue-slug>.json`.
- Schema v1 is defined by the `Snapshot` interface shared across all three spec files. Required top-level fields: `schemaVersion:1`, `pageUrl`, `userAgent`, `camera`, `viewport`, `pageViewport`, `sources`, `renderOrder`, `pixelHash`, `pixelHashBy`.
- `pageUrl` carries the production GH Pages URL; `_snapshot-replay.spec.ts` rewrites the host to `localhost:3000` for local replay — do not change this.
- `bug-snapshot.json` is large (~2 MB) because it serialises the full GPU tile-cache tile list; this is intentional for deterministic replay. Do not truncate it.
- The `__xgisReplaySnapshot(snap, {timeoutMs})` runtime API waits until every tile from `sources[*].tiles` is present in the GPU cache before returning; `matched:true` means full convergence.
- Pixel hash equality is intentionally NOT asserted across separate browser processes (GPU driver sub-pixel rounding varies); render-order length equality is the structural assertion in `_snapshot-replay.spec.ts`.

### Testing Requirements

- `../e2e/_snapshot-replay.spec.ts` — capture→replay roundtrip (Tokyo osm_style z16) + same-context determinism test; asserts render-order length equality and tile coverage <5% missing.
- `../e2e/_snapshot-from-paste.spec.ts` — manual debug helper; skipped by default (`PASTED_SNAPSHOT_JSON === null`); paste a snapshot to enable; produces `test-results/replay-from-paste.png`.
- `../e2e/_snapshot-button.spec.ts` — smoke-tests the `#snapshot-btn` UI in the playground demo; asserts clipboard contains a valid schema-v1 payload including a non-empty `renderOrder`.
- The `__*__` subdirectories inside `../e2e/` (screenshot outputs, probe dumps) are test artefacts written at runtime — not fixtures and not committed.

### Common Patterns

- To reproduce a new bug: open devtools in the playground, run `copy(JSON.stringify(await __xgisSnapshot(), null, 2))`, save to a file here, wire it into `_snapshot-replay.spec.ts` or use `_snapshot-from-paste.spec.ts`.
- The `__xgisStartDrawOrderTrace()` + `__xgisMap.invalidate()` + 100 ms settle sequence (seen in both replay specs) arms the per-frame render-order trace before snapshot capture — always follow this pattern when capturing for comparison.

## Dependencies

### Internal

- Consumed by `../e2e/_snapshot-replay.spec.ts`, `../e2e/_snapshot-from-paste.spec.ts`, `../e2e/_snapshot-button.spec.ts`.
- Snapshot schema mirrors the `Snapshot` interface defined in those spec files; keep in sync if schema version bumps.

### External

- None (pure JSON data).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

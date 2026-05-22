<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# scripts

## Purpose
One-off developer scripts run with `bun run scripts/<name>.ts` from inside `runtime/`. They verify external tile assets directly (header parse + per-tile probe) outside the render pipeline, used when debugging "empty screen / missing data" suspicions against a real archive.

## Key Files
| File | Description |
|------|-------------|
| `inspect-firenze-pmtiles.ts` | Fetches the Firenze PMTiles archive header (`bytesToHeader` from `pmtiles`) and probes individual tiles at the Florence center to confirm the archive contains data at the zoom levels the renderer requests. |

## For AI Agents

### Working In This Directory
- Standalone scripts, not imported by the runtime. They talk to the network and `pmtiles` directly — no GPU, no `XGISMap`.
- Use these as templates when you need to answer "does the source actually have this tile?" before assuming a render bug.

### Testing Requirements
- No tests. Verify by running `bun run scripts/<name>.ts` and reading the console output.

### Common Patterns
- Read header → resolve tile address → range-fetch → decode → print. Pure diagnostics.

## Dependencies

### Internal
- None (uses raw `pmtiles`, not the runtime loader).

### External
- `pmtiles` (`bytesToHeader`, `TileType`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

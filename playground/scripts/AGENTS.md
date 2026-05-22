<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/scripts

## Purpose
One-off diagnostic and investigation scripts run directly with `bun run scripts/<file>.ts`. These scripts are not part of the build or test pipeline; they are authored for a specific investigation and left in place as documented probes that can be re-run if the underlying question resurfaces.

## Key Files
| File | Description |
|------|-------------|
| `sprite-sdf-buffer-probe.ts` | Fetches the live OFM Bright sprite sheet (JSON + PNG), parses every SDF icon entry, and reports the empirical edge alpha byte + buffer pixels. Used to determine the spritezero SDF normalisation constant needed for `icon-halo` rendering (the constant is not in the codebase and cannot be guessed). Output: edge alpha histogram and per-entry stats to stdout. Run with `bun run scripts/sprite-sdf-buffer-probe.ts`. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- Scripts here are investigation tools, not production code. They may have side effects (network fetches, file writes to `playground/`).
- `sprite-sdf-buffer-probe.ts` makes live HTTPS requests to `tiles.openfreemap.org`; it will fail in offline environments.
- When adding a new script, add a comment at the top explaining what question it answers, what command to run it with, and what the expected output format is.
- Do not import from `@xgis/runtime` or `@xgis/compiler` in scripts — they run in a plain Bun Node-compatible context, not the browser.

### Testing Requirements
- No automated tests. Scripts are run manually.

### Common Patterns
- Top-of-file comment: purpose, `Run: bun run scripts/<name>.ts`, output description.
- Use `pngjs` for PNG decoding (available as a dev dep).

## Dependencies

### Internal
- None.

### External
- `pngjs` ^7.0.0 (for PNG parsing)
- Network access to `tiles.openfreemap.org`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

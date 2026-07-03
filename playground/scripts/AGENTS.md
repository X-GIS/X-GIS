<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/scripts

## Purpose

One-off diagnostic and investigation scripts run directly with `bun run scripts/<file>.ts`. These scripts are not part of the build or test pipeline; they are authored for a specific investigation and left in place as documented probes that can be re-run if the underlying question resurfaces. Currently the directory holds a single script used during icon-halo implementation research.

## Key Files

| File                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sprite-sdf-buffer-probe.ts` | Fetches the live OFM Bright sprite sheet (`tiles.openfreemap.org/sprites/ofm_f384/ofm.{json,png}`), parses every entry with `sdf: true`, and reports the empirical edge alpha byte and buffer pixels per icon. Outputs a per-entry median alpha on mid-cross plus a dominant edge byte (histogram local-min in 32–224 range) and a 1-px alpha slope estimate. Used to derive the spritezero SDF normalisation constant for `icon-halo` compositing — the constant is server-baked and cannot be read from the codebase. Run with `bun run scripts/sprite-sdf-buffer-probe.ts`. |

## For AI Agents

### Working In This Directory

- Scripts here are investigation tools, not production code. They may have side effects (network fetches; file writes to `playground/`).
- `sprite-sdf-buffer-probe.ts` makes live HTTPS requests to `tiles.openfreemap.org`; it will fail in offline environments.
- When adding a new script, add a comment block at the top explaining what question it answers, the exact `bun run` invocation, and the expected output format.
- Do not import from `@xgis/runtime` or `@xgis/compiler` in scripts — they run in a plain Bun Node-compatible context, not a browser WebGPU environment.
- The directory has no subdirectories; place any new scripts directly here.

### Testing Requirements

- No automated tests. Scripts are run manually.

### Common Patterns

- Top-of-file block comment: purpose, `Run: bun run scripts/<name>.ts`, output format description.
- Use `pngjs` for PNG decoding (`PNG.sync.read` from `pngjs`) — available as a dev dep in `playground/`.
- Use `fetch` directly (Bun built-in); no Node `https` module needed.

## Dependencies

### Internal

- None.

### External

- `pngjs` ^7.0.0 (PNG parsing via `PNG.sync.read`)
- Network access to `tiles.openfreemap.org`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

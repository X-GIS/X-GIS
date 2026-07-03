<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# e2e (top-level)

## Purpose

Top-level end-to-end test assets that live outside the `playground/` package. This directory is a designated landing zone for pixel-match survey output and scenario-specific generated data that belongs to repo-root server configurations rather than the `playground/` package. All runnable Playwright specs and their primary output directories live in `playground/e2e/`; anything placed here is generated data produced by those specs under an alternate configuration. As of 2026-06-03 no generated subdirectories are present.

## Key Files

| File                                                                                                 | Description |
| ---------------------------------------------------------------------------------------------------- | ----------- |
| _(none — no source files exist here; this directory holds only generated output when specs are run)_ |             |

## For AI Agents

### Working In This Directory

- This directory contains only generated output. Do not write source code here.
- Generated pixel-match survey directories follow the naming convention `__<scenario-name>__/` and contain `xgis.png`, `maplibre.png`, and `buckets.json`. They are excluded from enumeration per project convention.
- To regenerate output: run the relevant pixel-match spec from `playground/` (e.g., `bun run test:e2e -- --grep liberty-raster`). Baselines update with `-- --update-snapshots`.
- If you need to add new top-level e2e assets for a non-playground server config, create a new `__<scenario>__/` subdirectory and document the driving spec here.

### Testing Requirements

- No runnable tests live directly in this directory. All Playwright e2e specs are in `playground/e2e/`; see that directory's `AGENTS.md` for the full spec inventory.

### Common Patterns

- Generated survey directories use the `__<scenario-name>__/` naming convention (double-underscore prefix and suffix), consistent with `playground/e2e/__*__/` output dirs.

## Dependencies

### Internal

- Output produced by `playground/e2e/` Playwright specs (e.g., `_pixel-match-survey.spec.ts` and its scenario variants).

### External

- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

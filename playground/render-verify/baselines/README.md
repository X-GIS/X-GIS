# Matrix-gate baselines (the human-blessed corpus)

This directory holds **reviewed, committed** PNG baselines for `screenshot_diff`
matrix cells, plus a `<id>.meta.json` provenance stamp per baseline.

**The only thing that writes here is `bun run matrix:accept <cell.id>`.** The
runner (`playground/e2e/_matrix-gate.spec.ts`) never writes here — it writes
*candidate* PNGs to `playground/e2e/__matrix__/` (gitignored). A candidate
becomes a baseline only by an explicit human command after the render was
reviewed as **correct, not merely present**.

There is no `--update-snapshots`-style auto-rebake. `matrix:accept` refuses to
overwrite an existing baseline unless `--force` (an intentional render change
must be re-reviewed). This is the structural guarantee that a wrong baseline
cannot silently bless a bug.

See `../../../docs/verification/MATRIX.md` for the full review/accept flow.

Empty until the first baseline is accepted (Increment 2). No baselines are
committed in Increment 1 — every baseline-dependent cell starts as a
`candidate` and is coerced to a soft (non-blocking) gate by the runner.

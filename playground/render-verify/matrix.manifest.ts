// Visual-regression MATRIX gate — manifest assembler.
//
// The single render-gate authority `MATRIX` is now ASSEMBLED from per-axis
// fragments (matrix/matrix.{merc,globe,disc,line}.ts), each a pure
// declarative `MatrixCell[]` grouped by projection family. This is a faithful
// relocation: the assembled array is SET-identical to the previous inline
// table (same cells, same values) — the OracleSpec / MatrixCell schema stays
// in matrix-types, and the importers (e2e/_matrix-gate.spec.ts,
// scripts/matrix-accept.ts) still import `MATRIX` from here unchanged.
//
// Why split: every coverage feature used to append to one ~46-cell array and
// collide on it. Per-axis fragments make new cells append-only per concern —
// a new globe cell touches only matrix.globe.ts, a new disc cell only
// matrix.disc.ts, so two coverage PRs in different families don't conflict.
//
// To add a cell: append a record to the fragment for its projection family,
// point `dataset` at an existing demo, pick oracles, and follow the
// candidate→review→accept→green flow in docs/verification/MATRIX.md. Do NOT
// invent a `hard` screenshot_diff cell without a reviewed baseline — the
// runner coerces it to soft anyway.

import type { MatrixCell } from './matrix-types'
import { MATRIX_MERC } from './matrix/matrix.merc'
import { MATRIX_GLOBE } from './matrix/matrix.globe'
import { MATRIX_DISC } from './matrix/matrix.disc'
import { MATRIX_LINE } from './matrix/matrix.line'

export const MATRIX: MatrixCell[] = [
  ...MATRIX_MERC,
  ...MATRIX_GLOBE,
  ...MATRIX_DISC,
  ...MATRIX_LINE,
]

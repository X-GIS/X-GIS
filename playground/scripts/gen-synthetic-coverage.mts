// ═══ Synthetic S-100 coverage generator (#1158 GAP-1 INC-A render gate) ═══
//
// Emits the gate-3 test coverage the headed render spec (_coverage-render.spec.ts)
// asserts against: a 32×32 EPSG:4326 grid at 50-58°N (so the inverse-Mercator row
// mapping, A4, is exercised — the ~0.7-texel misplacement a linear V would cause
// lives up here), a linear NORTH→SOUTH value ramp (0 m at the north edge → 40 m at
// the south), a nodata HOLE in the centre, and 4 KNOWN-value corner cells the
// readback checks exactly. Committed as a tiny .xgcov (synthetic — no NOAA bytes).
//
//   bun playground/scripts/gen-synthetic-coverage.mts

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// barrel-free subpath: this script runs under bun, and the '@xgis/data' barrel's Vite
// `?worker` transitive imports don't load under plain bun.
import { encodeCoverage, type CoverageInput } from '@xgis/data/coverage'

const N = 32
const FILL = 1e6
const values = new Float32Array(N * N) // NORTH-UP: row 0 = north
for (let r = 0; r < N; r++) {
  const depth = (40 * r) / (N - 1) // north edge 0 m → south edge 40 m
  for (let c = 0; c < N; c++) values[r * N + c] = depth
}
// nodata hole — a 6×6 block in the centre
for (let r = 13; r < 19; r++) for (let c = 13; c < 19; c++) values[r * N + c] = FILL
// 4 known-value corner cells (distinct, away from the ramp so the readback is unambiguous)
values[0 * N + 0] = 5 // NW
values[0 * N + (N - 1)] = 15 // NE
values[(N - 1) * N + 0] = 25 // SW
values[(N - 1) * N + (N - 1)] = 35 // SE

const input: CoverageInput = {
  product: 's102',
  origin: [0, 50], // SW cell centre — lon 0°, lat 50°N
  spacing: [0.25, 0.25],
  size: [N, N],
  bands: [{ name: 'depth', unit: 'metres', kind: 'f32', nodata: FILL, values }],
  vertical: { datumCode: 23, sign: 'down' }, // LAT
}

const HERE = dirname(fileURLToPath(import.meta.url))
const out = join(HERE, '..', 'public', 'synthetic-bathymetry.xgcov')
const buf = await encodeCoverage(input)
writeFileSync(out, Buffer.from(buf))
console.log(
  `wrote ${out} (${buf.byteLength} bytes) — 32×32, 50-58°N, gradient + nodata hole + 4 known corners`,
)

// ═══ s100-to-xgcov — offline S-100 HDF5 → .xgcov converter (bun/node) ═══
//
// Reads an S-102 (DCF2) HDF5 file through the in-house zero-dep subset reader
// (pipeline/src/hdf5), normalizes the grid NORTH-UP (the single orientation flip;
// the runtime never sees south-row-first), reads the S-100 fill value from the
// Group_F band table, and writes a `.xgcov` v1 artifact via `encodeCoverage`. The
// reader is validated OFFLINE against h5py/GDAL (the oracles); nothing HDF5 ships
// at runtime.
//
// ── I/O CONTRACT (A6 — §12 read-the-header rule) ────────────────────────────
//   • `--out <file>` is REQUIRED (error + non-zero exit if absent).
//   • The artifact bytes go ONLY to `--out`, NEVER to stdout.
//   • stdout = a human summary (product, grid size, bands, vertical datum).
//   • stderr = warnings (attribute-casing, provenance) — never the artifact.
//   • ANY reader error ⇒ non-zero exit (a wrong grid must fail loudly, never silently).
//   • After writing, the output is `stat`-ed and its byte size printed (exit 0 ≠ file
//     written — a truncated/failed write is caught here).
//
// Usage:
//   bun pipeline/tools/s100-to-xgcov.ts <input.h5> --out <output.xgcov> [--quantize u16|f32]
// Flags:
//   --out <file>        REQUIRED. Destination path for the .xgcov artifact.
//   --quantize u16|f32  Band storage. f32 (default) keeps full precision; u16
//                       halves the size with scale/offset (error ≤ scale/2).
//   (--time / --merge are INC-C / INC-E and rejected here.)
//
// node builtins only (fs) — mirroring @xgis/pipeline's zero-dep charter. A devDep
// tool, excluded from the package build.

import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { openHdf5 } from '../src/hdf5/index'
import { readS102Coverage } from '../src/hdf5/s102'
// The .xgcov codec's canonical home is @xgis/data (the runtime decode authority, A8).
// Imported via the '@xgis/data/coverage' SUBPATH export (pipeline's @xgis/data
// devDependency declares the edge) — NOT the '@xgis/data' barrel, whose Vite `?worker`
// transitive imports are unloadable by plain bun (this tool's runtime). The subpath is
// a barrel-free direct module; the shipped reader (src, non-test) stays zero-dep.
import {
  encodeCoverage,
  southFirstToNorthUp,
  type CoverageInput,
  type BandKind,
} from '@xgis/data/coverage'

interface Args {
  input: string
  out: string
  quantize: BandKind
}

function parseArgs(argv: string[]): Args {
  let input = ''
  let out = ''
  let quantize: BandKind = 'f32'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') out = argv[++i] ?? ''
    else if (a === '--quantize') {
      const q = argv[++i]
      if (q !== 'u16' && q !== 'f32') fail(`--quantize must be u16 or f32 (got "${q}")`)
      quantize = q
    } else if (a === '--time' || a === '--merge') {
      fail(`${a} is INC-C/INC-E scope — not supported in INC-A`)
    } else if (a.startsWith('--')) {
      fail(`unknown flag "${a}"`)
    } else if (!input) {
      input = a
    }
  }
  if (!input) fail('missing input HDF5 path')
  if (!out) fail('--out <file> is REQUIRED (the artifact is written there, never to stdout)')
  return { input, out, quantize }
}

function fail(msg: string): never {
  process.stderr.write(`[s100-to-xgcov] error: ${msg}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const { input, out, quantize } = parseArgs(process.argv.slice(2))

  const bytes = readFileSync(input)
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

  let coverage
  try {
    coverage = await readS102Coverage(openHdf5(ab))
  } catch (e) {
    fail(`reading "${input}": ${e instanceof Error ? e.message : String(e)}`)
  }

  // Warnings (attribute-casing etc.) → stderr, never stdout.
  for (const w of coverage.warnings) process.stderr.write(`[s100-to-xgcov] warning: ${w}\n`)

  const [nLon, nLat] = coverage.numPoints
  const input$: CoverageInput = {
    product: coverage.product,
    origin: coverage.gridOrigin,
    spacing: coverage.gridSpacing,
    size: coverage.numPoints,
    bands: coverage.bands.map((b) => ({
      name: b.name,
      unit: b.unit,
      kind: quantize,
      nodata: b.fillValue,
      // the ONE north-up flip: reader storage (south-first) → .xgcov (row 0 = north)
      values: southFirstToNorthUp(b.values, nLon, nLat),
    })),
    vertical: coverage.vertical,
    sourceMeta: { horizontalCRS: coverage.horizontalCRS },
  }

  const artifact = await encodeCoverage(input$)
  writeFileSync(out, Buffer.from(artifact))

  // exit 0 ≠ file written — stat the output and report its real byte size.
  const size = statSync(out).size

  // stdout = the human summary ONLY.
  const bandDesc = coverage.bands
    .map((b) => `${b.name} (${b.unit}, fill=${b.fillValue})`)
    .join(', ')
  process.stdout.write(
    [
      `product:        ${coverage.product}`,
      `grid:           ${nLon} × ${nLat} cells  (${quantize})`,
      `origin (SW ctr): [${coverage.gridOrigin.join(', ')}]  spacing [${coverage.gridSpacing.join(', ')}]`,
      `bands:          ${bandDesc}`,
      `vertical datum: code ${coverage.vertical.datumCode ?? '—'} (sign ${coverage.vertical.sign})`,
      `wrote:          ${out}  (${size} bytes)`,
    ].join('\n') + '\n',
  )
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))

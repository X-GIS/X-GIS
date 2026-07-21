// ═══ s100ToXgcov — programmatic S-100 HDF5 → .xgcov conversion (runtime-usable) ═══
//
// The composition the `s100-to-xgcov` CLI wraps, exposed as a pure function so a
// SERVER (cron / edge function) or a BROWSER WORKER can convert an S-100 cell to
// the runtime `.xgcov` artifact without the CLI's fs I/O: read the HDF5 via the
// in-house zero-dep subset reader, normalize NORTH-UP (the single orientation
// flip), and `encodeCoverage`. Product-agnostic — S-102 bathymetry, S-104 water
// level, S-111 surface currents (any DCF2 gridded coverage the reader ingests).
//
// PACKAGE BOUNDARY (§12 / PR #1220): this module — UNLIKE the bare reader
// (`openHdf5` / `readS102Coverage`, which stay zero-dep) — imports the `.xgcov`
// codec from `@xgis/data/coverage`, so `@xgis/data` is a REAL `dependency` of
// `@xgis/pipeline` (not the devDep the CLI relied on): the tsconfig `paths` edge
// alone would let `tsc` pass while an installed consumer 500s at import. Consumers
// who want to bring their OWN encoder import the reader directly and skip this.

import { openHdf5 } from './index'
import { readS102Coverage } from './s102'
import { encodeCoverage, southFirstToNorthUp, type BandKind } from '@xgis/data/coverage'

export interface S100ToXgcovOptions {
  /** Band storage: `'f32'` (default) keeps full precision; `'u16'` halves the
   *  size with a per-band scale/offset (error ≤ scale/2). */
  quantize?: BandKind
}

export interface S100ToXgcovResult {
  /** The encoded `.xgcov` bytes — hand to `map.setCoverageData(id, buffer)` or
   *  serve/store as-is. */
  buffer: ArrayBuffer
  /** `'s102'` | `'s104'` | `'s111'` | `'generic'`, detected from the file's
   *  productSpecification. */
  product: string
  /** [nLon, nLat] grid size. */
  size: [number, number]
  /** Band names in artifact order (e.g. `['surfaceCurrentSpeed',
   *  'surfaceCurrentDirection']` for S-111). */
  bandNames: string[]
  /** Attribute-casing / provenance warnings surfaced by the reader (empty when
   *  the file is fully in-spec). */
  warnings: string[]
}

/** Convert S-100 (DCF2 gridded) HDF5 bytes to a runtime `.xgcov` artifact.
 *
 *  ```ts
 *  // browser worker: fetch YOUR OWN bucket (NOAA's THREDDS is CORS-blocked),
 *  // convert, and hand the bytes back to the main thread.
 *  const bytes = await (await fetch('/data/currents.h5')).arrayBuffer()
 *  const { buffer } = await s100ToXgcov(bytes)
 *  postMessage(buffer, [buffer])   // main thread: map.setCoverageData('currents', buffer)
 *  ```
 *
 *  Throws (never silently mis-renders) on any out-of-subset HDF5 construct or a
 *  grid/geometry disagreement — a wrong grid must fail loudly. */
export async function s100ToXgcov(
  hdf5Bytes: ArrayBuffer,
  opts: S100ToXgcovOptions = {},
): Promise<S100ToXgcovResult> {
  const kind: BandKind = opts.quantize ?? 'f32'
  const coverage = await readS102Coverage(openHdf5(hdf5Bytes))
  const [nLon, nLat] = coverage.numPoints
  const buffer = await encodeCoverage({
    product: coverage.product,
    origin: coverage.gridOrigin,
    spacing: coverage.gridSpacing,
    size: coverage.numPoints,
    bands: coverage.bands.map((b) => ({
      name: b.name,
      unit: b.unit,
      kind,
      nodata: b.fillValue,
      // The ONE north-up flip: reader storage (south-first) → .xgcov (row 0 = north).
      values: southFirstToNorthUp(b.values, nLon, nLat),
    })),
    vertical: coverage.vertical,
    sourceMeta: { horizontalCRS: coverage.horizontalCRS },
  })
  return {
    buffer,
    product: coverage.product,
    size: coverage.numPoints,
    bandNames: coverage.bands.map((b) => b.name),
    warnings: coverage.warnings,
  }
}

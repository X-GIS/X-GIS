// ═══ readCoverageFromHdf5 — HDF5 (S-100) → CoverageHandle, no wire format (ADR-0010) ═══
//
// The runtime replacement for `decodeCoverage(.xgcov)`: read the S-100 HDF5
// standard the data is ALREADY in, in place, and build the CoverageHandle the
// renderer consumes — via `coverageFromGrids`, with no house blob in between.
// Product-agnostic (S-102 bathymetry, S-104 water level, S-111 currents). The ONE
// orientation normalize (reader storage is south-row-first; the handle is north-up)
// lives here, exactly where the retired `s100-to-xgcov` converter did it.

import { openHdf5, openHdf5Url, type RangeReaderOptions } from './index'
import { readS102Coverage } from './s102'
import { coverageFromGrids, southFirstToNorthUp, type CoverageHandle } from '../coverage/format'

/** Build the north-up CoverageHandle from a reader `S100Coverage` (the single
 *  south-first → north-up flip, shared by the buffer + range entry points). */
function toHandle(cov: Awaited<ReturnType<typeof readS102Coverage>>): CoverageHandle {
  const [nLon, nLat] = cov.numPoints
  return coverageFromGrids({
    product: cov.product,
    origin: cov.gridOrigin,
    spacing: cov.gridSpacing,
    size: cov.numPoints,
    bands: cov.bands.map((b) => ({
      name: b.name,
      unit: b.unit,
      kind: 'f32',
      nodata: b.fillValue,
      // reader storage (south-first) → north-up (the handle/renderer order).
      values: southFirstToNorthUp(b.values, nLon, nLat),
    })),
    vertical: cov.vertical,
    // `time` carries the forecast group decoded + the axis it sits on (numGRP, interval),
    // so a caller can read the handle's valid-time and know how many hours are steppable.
    sourceMeta: { horizontalCRS: cov.horizontalCRS, time: cov.time },
  })
}

/** Read an S-100 (DCF2 gridded) HDF5 buffer into a CoverageHandle — the CPU
 *  value-readout authority + the renderer's grid source. Throws (never silently
 *  mis-renders) on any out-of-subset HDF5 construct or a grid/geometry mismatch. */
export async function readCoverageFromHdf5(
  hdf5Bytes: ArrayBuffer,
  opts?: { group?: number },
): Promise<CoverageHandle> {
  return toHandle(await readS102Coverage(await openHdf5(hdf5Bytes), opts))
}

/** Read an S-100 cell over HTTP Range (ADR-0010 range-streaming) — pulls only the
 *  METADATA + the chunks the coverage actually reads (the first forecast group's grid),
 *  NOT the whole file. A multi-timestep S-111 cell stores ~24 forecast hours + tile
 *  pyramids; this reads only what the CoverageHandle needs, so a ~12 MB cell streams in
 *  ~⅓ the bytes. Produces the identical handle to the buffer path — same geometry, same
 *  values — so nothing downstream changes. The server MUST honour Range (a CORS proxy
 *  that does is the norm); callers fall back to `readCoverage(buffer)` when it does not. */
export async function readCoverageFromHdf5Url(
  url: string,
  opts?: RangeReaderOptions & { blockSize?: number; group?: number },
): Promise<CoverageHandle> {
  return toHandle(await readS102Coverage(await openHdf5Url(url, opts), { group: opts?.group }))
}

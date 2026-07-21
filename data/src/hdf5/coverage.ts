// ═══ readCoverageFromHdf5 — HDF5 (S-100) → CoverageHandle, no wire format (ADR-0010) ═══
//
// The runtime replacement for `decodeCoverage(.xgcov)`: read the S-100 HDF5
// standard the data is ALREADY in, in place, and build the CoverageHandle the
// renderer consumes — via `coverageFromGrids`, with no house blob in between.
// Product-agnostic (S-102 bathymetry, S-104 water level, S-111 currents). The ONE
// orientation normalize (reader storage is south-row-first; the handle is north-up)
// lives here, exactly where the retired `s100-to-xgcov` converter did it.

import { openHdf5 } from './index'
import { readS102Coverage } from './s102'
import { coverageFromGrids, southFirstToNorthUp, type CoverageHandle } from '../coverage/format'

/** Read an S-100 (DCF2 gridded) HDF5 buffer into a CoverageHandle — the CPU
 *  value-readout authority + the renderer's grid source. Throws (never silently
 *  mis-renders) on any out-of-subset HDF5 construct or a grid/geometry mismatch. */
export async function readCoverageFromHdf5(hdf5Bytes: ArrayBuffer): Promise<CoverageHandle> {
  const cov = await readS102Coverage(await openHdf5(hdf5Bytes))
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
    sourceMeta: { horizontalCRS: cov.horizontalCRS },
  })
}

// ═══ readCoverage — sniff the gridded-standard container, dispatch to its reader ═══
//
// The `coverage` source fetches bytes and must turn them into a CoverageHandle. The
// container is identified by its MAGIC, NOT by the URL extension (ADR-0010: read
// whichever standard the data is already in) — a CORS proxy or a content-negotiated
// URL need not end in `.h5`. `coverage` stays a SINGLE source type; the READER is
// per-format, exactly as `vector`/`tilejson` fan out to per-format tile loaders.
//
// HDF5 (S-102/S-104/S-111) reads in place today. GRIB2 (GFS wind, #1273) and NetCDF
// classic (SST, #1274) are separate tracks — they sniff to a CLEAR, track-linked
// error instead of a cryptic HDF5 superblock-parse failure on the wrong magic.
// NetCDF-4 is HDF5 on disk, so it takes the HDF5 path (no special case).

import { readCoverageFromHdf5 } from '../hdf5/coverage'
import type { CoverageHandle } from './format'

export type CoverageContainer = 'hdf5' | 'grib2' | 'netcdf-classic' | 'unknown'

// HDF5 superblock signature: \x89 H D F \r \n \x1a \n (bytes.ts / gen-h5-fixtures.py).
const HDF5_SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** Identify a gridded-coverage container by its leading magic bytes. HDF5's signature
 *  may sit at offset 0 or a later power-of-2 boundary (the superblock search the reader
 *  itself does); the S-100 cells we read place it at 0, which is all this routing sniff
 *  needs. Returns `'unknown'` for a truncated/empty body (→ a clear error downstream). */
export function sniffCoverageContainer(bytes: ArrayBuffer): CoverageContainer {
  const n = Math.min(8, bytes.byteLength)
  const b = new Uint8Array(bytes, 0, n)
  if (n >= 8 && HDF5_SIG.every((v, i) => b[i] === v)) return 'hdf5'
  // 'GRIB' — GRIB1/GRIB2 share the leading magic; edition is byte 7 (not needed to route).
  if (n >= 4 && b[0] === 0x47 && b[1] === 0x52 && b[2] === 0x49 && b[3] === 0x42) return 'grib2'
  // 'CDF' + a classic version byte (1 classic, 2 64-bit-offset, 5 CDF-5). NetCDF-4 is
  // HDF5 on disk (\x89HDF) and is caught above, so it is NOT netcdf-classic here.
  if (n >= 4 && b[0] === 0x43 && b[1] === 0x44 && b[2] === 0x46 && (b[3] === 1 || b[3] === 2 || b[3] === 5))
    return 'netcdf-classic'
  return 'unknown'
}

/** Read a gridded-coverage payload into a CoverageHandle, dispatching on the container
 *  magic (ADR-0010). HDF5 (S-100) reads in place today; the other standards resolve to
 *  a clear, track-linked error rather than a cryptic mis-parse. The `coverage` source
 *  and `map.setCoverageData` both enter here, so a new format is wired in ONE place. */
export async function readCoverage(bytes: ArrayBuffer): Promise<CoverageHandle> {
  switch (sniffCoverageContainer(bytes)) {
    case 'hdf5':
      return readCoverageFromHdf5(bytes)
    case 'grib2':
      throw new Error(
        '[coverage] GRIB2 container not yet supported — the GFS wind track (#1273) adds the ' +
          'GRIB2 reader; only S-100 HDF5 reads in place today (ADR-0010).',
      )
    case 'netcdf-classic':
      throw new Error(
        '[coverage] NetCDF-classic container not yet supported — the SST track (#1274) adds the ' +
          'NetCDF reader; only S-100 HDF5 reads today (NetCDF-4 is HDF5 on disk and DOES read).',
      )
    default:
      throw new Error(
        '[coverage] unrecognized gridded container — expected S-100 HDF5 (signature \\x89HDF). ' +
          'GRIB2 (#1273) and NetCDF (#1274) are separate tracks.',
      )
  }
}

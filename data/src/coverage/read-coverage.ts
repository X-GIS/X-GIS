// ═══ readCoverage — pick the gridded-standard reader by URL, like vector tiles ═══
//
// The `coverage` source fetches a payload and turns it into a CoverageHandle. Which
// STANDARD it is (HDF5 / GRIB2 / NetCDF) is decided the SAME way a vector source picks
// pmtiles-vs-tilejson-vs-mvt: from the URL extension (`detectVectorTileFormat`, the
// codebase's single authority for "what format is at this URL"). `coverage` stays ONE
// source type; the reader is per-format — no per-format `type:`. This deliberately does
// NOT sniff magic bytes: the vector path learned URL-wins the hard way (a `.pmtiles →
// …v4.json` rewrite crashed on "Wrong magic number" until the URL took precedence), and
// URL routing lets an unsupported container be rejected without a house-specific probe.
//
// HDF5 (S-102/S-104/S-111) reads in place today. GRIB2 (GFS #1273) and NetCDF (SST
// #1274) are separate tracks — a `.grib2`/`.nc` URL fails with a CLEAR, track-linked
// error. An unknown/extensionless URL (a CORS proxy that drops the extension) defaults
// to HDF5, the only supported container — the reader then gives a clear error if the
// bytes are not actually HDF5. NetCDF-4 is HDF5 on disk, so a `.nc` that is really an
// HDF5 file still round-trips through the HDF5 reader once its track lands.

import { readCoverageFromHdf5 } from '../hdf5/coverage'
import type { CoverageHandle } from './format'

export type CoverageFormat = 'hdf5' | 'grib2' | 'netcdf'

/** Which gridded-standard reader the URL asks for — extension-decisive, mirroring
 *  `detectVectorTileFormat`. Query (`?…`) and fragment (`#…`) are stripped and the match
 *  is case-insensitive (S3 keys / Windows hosts uppercase extensions). Returns `null`
 *  for an unknown/extensionless URL (the caller defaults to the only supported format). */
export function detectCoverageFormat(url: string): CoverageFormat | null {
  if (typeof url !== 'string') return null
  const p = url.split('?')[0]!.split('#')[0]!.toLowerCase()
  if (p.endsWith('.h5') || p.endsWith('.hdf5')) return 'hdf5'
  if (p.endsWith('.grib2') || p.endsWith('.grb2') || p.endsWith('.grb') || p.endsWith('.grib'))
    return 'grib2'
  if (p.endsWith('.nc') || p.endsWith('.nc4') || p.endsWith('.cdf')) return 'netcdf'
  return null
}

/** Read a gridded-coverage payload into a CoverageHandle, dispatching to the reader the
 *  URL names (ADR-0010; `url` omitted → the only supported container, HDF5). HDF5 reads
 *  in place today; a `.grib2`/`.nc` URL resolves to a clear, track-linked error instead
 *  of a cryptic mis-parse. The `coverage` source and `map.setCoverageData` both enter
 *  here, so a new standard is wired in ONE place. */
export async function readCoverage(bytes: ArrayBuffer, url?: string): Promise<CoverageHandle> {
  const format = url ? detectCoverageFormat(url) : null
  if (format === 'grib2')
    throw new Error(
      '[coverage] GRIB2 not yet supported — the GFS wind track (#1273) adds the GRIB2 ' +
        'reader; only S-100 HDF5 reads in place today (ADR-0010).',
    )
  if (format === 'netcdf')
    throw new Error(
      '[coverage] NetCDF not yet supported — the SST track (#1274) adds the NetCDF reader; ' +
        'only S-100 HDF5 reads today (a NetCDF-4 file that is HDF5 on disk will read then).',
    )
  // 'hdf5' or null (unknown/extensionless → default to the only supported container).
  return readCoverageFromHdf5(bytes)
}

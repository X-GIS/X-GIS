// ═══ readCoverage — URL-extension format routing + dispatch (ADR-0010) ═══
//
// The `coverage` source + setCoverageData enter here. Format is picked by URL extension,
// the SAME mechanism vector tiles use (`detectVectorTileFormat`) — NOT by magic bytes.
// These gates pin: the extension routing (hdf5 / grib2 / netcdf / null, query+fragment
// stripped, case-insensitive); that a real S-100 HDF5 cell round-trips through `valueAt`
// (with a `.h5` URL, an unknown-extension URL, and no URL); and that a `.grib2`/`.nc` URL
// fails with a CLEAR, track-linked error before any read.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCoverage, detectCoverageFormat } from './read-coverage'

const HERE = dirname(fileURLToPath(import.meta.url))
function fixture(name: string): ArrayBuffer {
  const b = readFileSync(join(HERE, '..', 'hdf5', '__fixtures__', name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

describe('detectCoverageFormat — URL-extension routing (mirrors detectVectorTileFormat)', () => {
  it('routes HDF5 / GRIB2 / NetCDF extensions', () => {
    expect(detectCoverageFormat('https://cdn/currents.h5')).toBe('hdf5')
    expect(detectCoverageFormat('x.hdf5')).toBe('hdf5')
    expect(detectCoverageFormat('gfs.grib2')).toBe('grib2')
    expect(detectCoverageFormat('gfs.grb')).toBe('grib2')
    expect(detectCoverageFormat('sst.nc')).toBe('netcdf')
    expect(detectCoverageFormat('sst.nc4')).toBe('netcdf')
  })

  it('strips ?query and #fragment, and is case-insensitive (S3 keys / Windows hosts)', () => {
    expect(detectCoverageFormat('https://cdn/currents.h5?v=2&token=abc')).toBe('hdf5')
    expect(detectCoverageFormat('currents.H5#frag')).toBe('hdf5')
    expect(detectCoverageFormat('GFS.GRIB2')).toBe('grib2')
  })

  it("returns null for an unknown / extensionless URL (a proxy that drops the extension)", () => {
    expect(detectCoverageFormat('https://proxy/currents-latest')).toBeNull()
    expect(detectCoverageFormat('data.geojson')).toBeNull()
    expect(detectCoverageFormat('')).toBeNull()
  })
})

describe('readCoverage — dispatch on the URL-declared format', () => {
  it('reads a real S-100 HDF5 cell for a `.h5` URL (valueAt round-trips)', async () => {
    const h = await readCoverage(fixture('asym_southflip.h5'), 'https://cdn/asym.h5')
    expect(h.header.product).toBe('s102')
    expect(h.valueAt(5, 50)).toBe(10) // SW cell, positive-down verbatim
    expect(Number.isNaN(h.valueAt(9, 50)!)).toBe(true) // SE nodata → NaN
  })

  it('defaults to HDF5 for an extensionless URL and for no URL (the host-push path)', async () => {
    const proxied = await readCoverage(fixture('asym_southflip.h5'), 'https://proxy/latest')
    expect(proxied.valueAt(5, 50)).toBe(10)
    const pushed = await readCoverage(fixture('asym_southflip.h5')) // setCoverageData: no URL
    expect(pushed.valueAt(5, 50)).toBe(10)
  })

  it('a `.grib2` URL fails with a clear, track-linked (#1273) error before reading', async () => {
    await expect(readCoverage(fixture('asym_southflip.h5'), 'x.grib2')).rejects.toThrow(
      /GRIB2.*#1273/,
    )
  })

  it('a `.nc` URL fails with a clear, track-linked (#1274) error', async () => {
    await expect(readCoverage(fixture('asym_southflip.h5'), 'sst.nc')).rejects.toThrow(
      /NetCDF.*#1274/,
    )
  })
})

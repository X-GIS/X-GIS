// ═══ readCoverage — container sniff + dispatch (ADR-0010) ═══
//
// The `coverage` source + setCoverageData enter here. These gates pin: the magic-byte
// sniff (HDF5 / GRIB2 / NetCDF-classic / unknown, incl. a truncated body); that a real
// S-100 HDF5 cell routes to the reader and round-trips through `valueAt`; and that the
// not-yet-supported standards fail with a CLEAR, track-linked error (not a cryptic HDF5
// superblock mis-parse on the wrong magic).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCoverage, sniffCoverageContainer } from './read-coverage'

const HERE = dirname(fileURLToPath(import.meta.url))
function bufOf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}
function fixture(name: string): ArrayBuffer {
  const b = readFileSync(join(HERE, '..', 'hdf5', '__fixtures__', name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

describe('sniffCoverageContainer — magic-byte routing', () => {
  it('detects HDF5 by its 8-byte superblock signature', () => {
    expect(sniffCoverageContainer(bufOf(0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      'hdf5',
    )
    // a real committed S-100 cell sniffs as hdf5
    expect(sniffCoverageContainer(fixture('asym_southflip.h5'))).toBe('hdf5')
  })

  it("detects GRIB (GRIB1/2 share the leading magic 'GRIB')", () => {
    expect(sniffCoverageContainer(bufOf(0x47, 0x52, 0x49, 0x42, 0, 0, 2, 0))).toBe('grib2')
  })

  it("detects NetCDF classic by 'CDF' + a classic version byte (1|2|5)", () => {
    expect(sniffCoverageContainer(bufOf(0x43, 0x44, 0x46, 0x01))).toBe('netcdf-classic')
    expect(sniffCoverageContainer(bufOf(0x43, 0x44, 0x46, 0x05))).toBe('netcdf-classic')
    // 'CDF' with a non-classic version byte is NOT netcdf-classic
    expect(sniffCoverageContainer(bufOf(0x43, 0x44, 0x46, 0x09))).toBe('unknown')
  })

  it("a truncated/empty body is 'unknown' (never a false HDF5 hit)", () => {
    expect(sniffCoverageContainer(bufOf(0x89, 0x48))).toBe('unknown') // 2 bytes < 8
    expect(sniffCoverageContainer(new ArrayBuffer(0))).toBe('unknown')
    expect(sniffCoverageContainer(bufOf(1, 2, 3, 4, 5, 6, 7, 8))).toBe('unknown')
  })
})

describe('readCoverage — dispatch on container', () => {
  it('routes a real S-100 HDF5 cell to the reader (valueAt round-trips)', async () => {
    const h = await readCoverage(fixture('asym_southflip.h5'))
    expect(h.header.product).toBe('s102')
    expect(h.valueAt(5, 50)).toBe(10) // SW cell, positive-down verbatim
    expect(Number.isNaN(h.valueAt(9, 50)!)).toBe(true) // SE nodata → NaN
    expect(h.meta.vertical).toEqual({ datumCode: 23, sign: 'down' })
  })

  it('GRIB2 fails with a clear, track-linked (#1273) error — not an HDF5 mis-parse', async () => {
    await expect(readCoverage(bufOf(0x47, 0x52, 0x49, 0x42, 0, 0, 2, 0))).rejects.toThrow(
      /GRIB2.*#1273/,
    )
  })

  it('NetCDF classic fails with a clear, track-linked (#1274) error', async () => {
    await expect(readCoverage(bufOf(0x43, 0x44, 0x46, 0x01))).rejects.toThrow(/NetCDF.*#1274/)
  })

  it('an unrecognized container fails naming the expected HDF5 signature', async () => {
    await expect(readCoverage(bufOf(1, 2, 3, 4, 5, 6, 7, 8))).rejects.toThrow(
      /unrecognized gridded container.*HDF5/,
    )
  })
})

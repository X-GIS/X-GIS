// ═══ s100ToXgcov programmatic API (#1272) ═══
//
// The runtime-usable composition (reader → north-up flip → encodeCoverage), the
// same path the CLI wraps but callable in a server / browser worker. Asserts it
// round-trips an S-111 cell to a decodable .xgcov: product, bands, north-up flip,
// and the -9999 fill → NaN mapping. Uses the committed synthetic S-111 fixture.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCoverage } from '@xgis/data/coverage'
import { s100ToXgcov } from './to-xgcov'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '__fixtures__')
function ab(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name + '.json'), 'utf8'))
}

describe('s100ToXgcov — programmatic S-111 conversion', () => {
  it('converts an S-111 cell to a decodable .xgcov (product + bands + north-up flip)', async () => {
    const g = golden('s111_dcf2')
    const { buffer, product, size, bandNames, warnings } = await s100ToXgcov(
      ab(join(FIX, 's111_dcf2.h5')),
    )
    expect(product).toBe('s111')
    expect(size).toEqual([g.nLon, g.nLat])
    expect(bandNames).toEqual(['surfaceCurrentSpeed', 'surfaceCurrentDirection'])
    expect(Array.isArray(warnings)).toBe(true)

    const handle = await decodeCoverage(buffer)
    expect(handle.header.product).toBe('s111')
    const expected = (g.speed_north_up as number[][]).flat()
    const v = handle.band('surfaceCurrentSpeed').values
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === (g.fillValue as number)) expect(Number.isNaN(v[i]!)).toBe(true)
      else expect(v[i]).toBeCloseTo(expected[i]!, 5)
    }
  })

  it('u16 quantization decodes to codes + values within a bin of the f32 path', async () => {
    // (On this TINY 3×4 fixture the deflate frame overhead dominates, so u16 is
    // not smaller than f32 — the halving only pays off at real grid sizes; here
    // we assert the quantization is CORRECT, not that it shrank.)
    const g = golden('s111_dcf2')
    const u16 = await s100ToXgcov(ab(join(FIX, 's111_dcf2.h5')), { quantize: 'u16' })
    const handle = await decodeCoverage(u16.buffer)
    const speed = handle.band('surfaceCurrentSpeed')
    expect(speed.codes).toBeDefined() // u16 bands carry the raw quantization codes
    const expected = (g.speed_north_up as number[][]).flat()
    const { min, max } = speed.header
    const binWidth = (max - min) / 65534
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === (g.fillValue as number)) expect(Number.isNaN(speed.values[i]!)).toBe(true)
      else expect(Math.abs(speed.values[i]! - expected[i]!)).toBeLessThanOrEqual(binWidth)
    }
  })

  it('an out-of-subset HDF5 construct throws (never a silent mis-render)', async () => {
    await expect(s100ToXgcov(ab(join(FIX, 'neg_v3_latest.h5')))).rejects.toThrow(
      /superblock version 3/,
    )
  })
})

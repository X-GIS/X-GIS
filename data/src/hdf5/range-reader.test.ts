// ═══ RangeReader — HTTP-range streaming of an S-100 cell (ADR-0010 #1284-4) ═══
//
// A fake `fetch` serves ranges out of a committed fixture and LOGS every requested
// range. Gates: the reader learns the size from the probe's Content-Range; the full
// S-102 semantic read over the range path yields the SAME geometry + values as the
// whole-buffer path (correctness); every fetch is a 206 ranged request (never a
// whole-file GET); the Cursor's block cache means no byte range is fetched twice; and
// a server that ignores Range (200) fails loudly.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5, openHdf5Range } from './index'
import { RangeReader } from './range-reader'
import { readS102Coverage } from './s102'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
function fileBytes(name: string): Uint8Array {
  return readFileSync(join(FIX, name))
}

interface FetchLog {
  ranges: [number, number][]
  bytes: number
}

/** A fake `fetch` that answers `Range: bytes=a-b` from `data` with a 206 + Content-Range,
 *  logging every served range. `ignoreRange` simulates a server that returns the whole
 *  body (200) — the failure the probe must reject. */
function rangeFetch(data: Uint8Array, log: FetchLog, ignoreRange = false): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (ignoreRange) return new Response(data, { status: 200 })
    const header = (init?.headers as Record<string, string>).Range
    const m = /bytes=(\d+)-(\d+)/.exec(header)!
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), data.byteLength - 1)
    log.ranges.push([start, end])
    log.bytes += end - start + 1
    return new Response(data.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` },
    })
  }) as unknown as typeof globalThis.fetch
}

describe('RangeReader — S-100 over HTTP range', () => {
  it('learns the size from the probe Content-Range', async () => {
    const data = fileBytes('sb_v0_symtab.h5')
    const log: FetchLog = { ranges: [], bytes: 0 }
    const rr = await RangeReader.open('http://x/a.h5', { fetch: rangeFetch(data, log) })
    expect(rr.byteLength).toBe(data.byteLength)
    expect(log.ranges[0]).toEqual([0, 0]) // the 1-byte probe
  })

  it('reads the SAME grid + geometry as the whole-buffer path, over ranged fetches only', async () => {
    const data = fileBytes('s111_dcf2.h5')
    // ground truth via the buffer path
    const want = await readS102Coverage(await openHdf5(data.buffer.slice(0)))

    const log: FetchLog = { ranges: [], bytes: 0 }
    const rr = await RangeReader.open('http://x/currents.h5', { fetch: rangeFetch(data, log) })
    const got = await readS102Coverage(await openHdf5Range(rr))

    expect(got.product).toBe(want.product)
    expect(got.numPoints).toEqual(want.numPoints)
    expect(got.gridOrigin).toEqual(want.gridOrigin)
    expect([...got.bands[0]!.values]).toEqual([...want.bands[0]!.values])
    expect([...got.bands[1]!.values]).toEqual([...want.bands[1]!.values])

    // Every fetch is a real ranged request (never a whole-file GET) — probe + block(s).
    expect(log.ranges.length).toBeGreaterThan(1)
    // The Cursor's block cache collapses the reader's MANY reads (superblock, object
    // headers, b-tree, Group_F, chunks) into a handful of block fetches — a sub-256 KB
    // cell is ONE block, so exactly one data fetch after the probe, served once.
    const dataFetches = log.ranges.slice(1) // drop the 1-byte size probe
    expect(dataFetches.length).toBeLessThanOrEqual(3)
    const seen = new Set<number>()
    for (const [s, e] of dataFetches)
      for (let b = s; b <= e; b++) {
        expect(seen.has(b)).toBe(false) // no byte fetched twice (cache hit, not re-fetch)
        seen.add(b)
      }
  })

  it('rejects a server that ignores Range (200 whole-body) — else every read pulls the file', async () => {
    const data = fileBytes('sb_v0_symtab.h5')
    const log: FetchLog = { ranges: [], bytes: 0 }
    await expect(
      RangeReader.open('http://x/a.h5', { fetch: rangeFetch(data, log, true) }),
    ).rejects.toThrow(/206|Range/)
  })
})

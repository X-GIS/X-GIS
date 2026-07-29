// ═══ A ranged cell read must not be a CHAIN of round trips (#1505) ═══
//
// The reader knew every address it was going to fetch and fetched them one at a time
// anyway. `readRawElements` walked its chunk list with an `ensure` per chunk, and
// `walkChunkNode` descended its children one `ensure` at a time — so a cell read cost one
// serial HTTP round trip per chunk and per b-tree node, each waiting out a full RTT before
// the next was issued.
//
// Measured on a real 4.5 MB NOAA S-102 cell over the same link, in the same run:
//
//     18 back-to-back range requests   2 977 ms      (zero overlap between any two)
//     one whole-file GET                 125 ms
//
// 24× — and all of it latency, not bandwidth: the ranged read pulled 4 608 KiB of the
// 4 608 KiB file. Nothing about that list required serialising; it is fully known before
// the first fetch.
//
// These gates pin the two properties that fix has to keep, over a fake `fetch` that records
// CONCURRENCY as well as ranges — because "fewer requests" and "requests that overlap" are
// different claims and only the second one is the fix:
//
//   1. Requests OVERLAP. Asserted as max-in-flight, which is the quantity the batch moves.
//      A revert to per-chunk `ensure` pins it at 1 and fails here by name.
//   2. Selectivity SURVIVES. Batching a chunk list must not quietly widen it into "fetch
//      the file" — a windowed read still transfers strictly less than a whole one.
//
// And correctness under both: the values must equal the whole-buffer path's, cell for cell.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cursor } from './bytes'
import { openHdf5, openHdf5Range } from './index'
import { RangeReader } from './range-reader'
import { readS102Coverage } from './s102'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
/** A real (committed) NOAA S-111 cell — chunked, and big enough at a small block size to
 *  need many blocks, which is what makes the serial-vs-overlapped distinction observable. */
const CELL = readFileSync(join(FIX, 'noaa_s111_cbofs.h5'))
/** Small enough that the 675 KB cell spans ~165 blocks, so a chunk list touches many. */
const BLOCK = 4096

interface Harness {
  fetch: typeof globalThis.fetch
  /** Ranged data requests, excluding the 1-byte size probe. */
  reads: number
  bytes: number
  /** The most requests this harness ever had in flight at once. */
  maxInFlight: number
}

/** A fake `fetch` that serves ranges out of `data` and records concurrency. The response is
 *  resolved on a later microtask so two overlapping calls are genuinely overlapping rather
 *  than each completing before the next begins — a synchronous stub would report
 *  `maxInFlight === 1` for correctly batched code and make this suite lie. */
function harness(data: Uint8Array): Harness {
  const h: Harness = { fetch: null as never, reads: 0, bytes: 0, maxInFlight: 0 }
  let live = 0
  h.fetch = (async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range
    if (header === undefined) return new Response(data.slice(), { status: 200 })
    const m = /bytes=(\d+)-(\d+)/.exec(header)!
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), data.byteLength - 1)
    const probe = start === 0 && end === 0
    live++
    if (live > h.maxInFlight) h.maxInFlight = live
    await Promise.resolve()
    await Promise.resolve()
    live--
    if (!probe) {
      h.reads++
      h.bytes += end - start + 1
    }
    return new Response(data.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` },
    })
  }) as unknown as typeof globalThis.fetch
  return h
}

/** Open the cell over the RANGED transport specifically — `openHdf5Url` would read a cell
 *  this small whole in one GET (`RangeReader.residentIfSmall`), which is the right thing for
 *  a caller and the wrong thing for a test about how ranged reads are issued. */
async function openRanged(h: Harness, block = BLOCK) {
  return openHdf5Range(await RangeReader.open('http://x/cell.h5', { fetch: h.fetch }), {
    blockSize: block,
  })
}

describe('a ranged cell read issues its requests CONCURRENTLY (#1505)', () => {
  it('overlaps its block fetches — the quantity the batch actually moves', async () => {
    const h = harness(CELL)
    await readS102Coverage(await openRanged(h))
    expect(h.reads, 'the read must actually have gone over the wire').toBeGreaterThan(4)
    expect(
      h.maxInFlight,
      `every range request waited for its predecessor (${h.reads} reads, max ${h.maxInFlight} ` +
        `in flight) — the chunk list and the b-tree level are both known before the first ` +
        `fetch, so this is the serial chain readRawElements/walkChunkNode used to pay`,
    ).toBeGreaterThan(1)
  })

  it('reads the SAME grid as the whole-buffer path — batching changed no bytes', async () => {
    const want = await readS102Coverage(await openHdf5(CELL.buffer.slice(0) as ArrayBuffer))
    const got = await readS102Coverage(await openRanged(harness(CELL)))
    expect(got.numPoints).toEqual(want.numPoints)
    expect(got.gridOrigin).toEqual(want.gridOrigin)
    for (let b = 0; b < want.bands.length; b++)
      expect([...got.bands[b]!.values], `band ${b}`).toEqual([...want.bands[b]!.values])
  })

  it('never fetches a byte twice — the block cache still owns residency', async () => {
    // The batch computes its runs from the MISSING blocks only. If it stopped consulting the
    // cache, a second dataset's chunk list would re-pull blocks the first already faulted in
    // and the read would silently cost double.
    const h = harness(CELL)
    const served: Array<[number, number]> = []
    const inner = h.fetch
    h.fetch = (async (u: string, init?: RequestInit) => {
      const header = (init?.headers as Record<string, string> | undefined)?.Range
      const m = header ? /bytes=(\d+)-(\d+)/.exec(header) : null
      if (m && !(Number(m[1]) === 0 && Number(m[2]) === 0))
        served.push([Number(m[1]), Math.min(Number(m[2]), CELL.byteLength - 1)])
      return inner(u, init)
    }) as unknown as typeof globalThis.fetch
    await readS102Coverage(await openRanged(h))
    const sorted = [...served].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length; i++)
      expect(
        sorted[i]![0],
        `range ${sorted[i]![0]}-${sorted[i]![1]} overlaps ${sorted[i - 1]![0]}-${sorted[i - 1]![1]}`,
      ).toBeGreaterThan(sorted[i - 1]![1])
  })
})

describe('batching does not widen the read into "fetch the file" (#1505)', () => {
  // The selectivity ADR-0010 §4 is about, pinned where it is DECIDABLE. End to end it is not:
  // `walkChunkNode` faults a 64 KB window around each b-tree node, so any cell small enough
  // to commit drags its own tail in while merely reading the chunk index and a windowed read
  // costs exactly what a whole one does — measured, and already written up at length in
  // bbox-window.test.ts, which gates its end-to-end version on an uncommitted real cell.
  //
  // What IS decidable here is the property the batch could plausibly break: "coalesce
  // contiguous runs" is exactly the shape of change that quietly swallows the GAP between two
  // wanted chunks and turns a sparse chunk list into one fetch of everything between them.
  it('coalesces ADJACENT blocks but never bridges a gap', async () => {
    const reads: Array<[number, number]> = []
    const reader = {
      byteLength: 64 * 20,
      read: async (offset: number, length: number) => {
        reads.push([offset, length])
        return new Uint8Array(length)
      },
    }
    const c = new Cursor(reader, 64)
    // Blocks 0,1,2 (adjacent) and block 10 — two runs, never one 11-block sweep.
    await c.ensureAll([
      { offset: 0, length: 10 },
      { offset: 64, length: 10 },
      { offset: 128, length: 10 },
      { offset: 640, length: 10 },
    ])
    expect(
      reads.sort((a, b) => a[0] - b[0]),
      'two runs: blocks 0-2 coalesced, block 10 apart',
    ).toEqual([
      [0, 192],
      [640, 64],
    ])
  })

  it('skips blocks already resident rather than re-coalescing over them', async () => {
    const reads: Array<[number, number]> = []
    const reader = {
      byteLength: 64 * 20,
      read: async (offset: number, length: number) => {
        reads.push([offset, length])
        return new Uint8Array(length)
      },
    }
    const c = new Cursor(reader, 64)
    await c.ensure(64, 10) // block 1 in
    reads.length = 0
    await c.ensureAll([
      { offset: 0, length: 10 },
      { offset: 64, length: 10 },
      { offset: 128, length: 10 },
    ])
    expect(
      reads.sort((a, b) => a[0] - b[0]),
      'block 1 is resident — it must not be re-fetched',
    ).toEqual([
      [0, 64],
      [128, 64],
    ])
  })
})

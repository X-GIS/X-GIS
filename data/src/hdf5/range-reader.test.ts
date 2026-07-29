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
  /** Unranged whole-file GETs (`residentIfSmall`'s one request). */
  whole: number
}

/** A fake `fetch` that answers `Range: bytes=a-b` from `data` with a 206 + Content-Range,
 *  logging every served range. `ignoreRange` simulates a server that returns the whole
 *  body (200) — the failure the probe must reject. */
function rangeFetch(
  data: Uint8Array,
  log: FetchLog,
  ignoreRange = false,
  /** Total to REPORT in the probe's Content-Range. Lets a test claim a size the fixture does
   *  not have, which is how the >8 MB branch of `residentIfSmall` is reachable without
   *  committing an 8 MB fixture. */
  reportedTotal = data.byteLength,
): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (ignoreRange) return new Response(data, { status: 200 })
    const header = (init?.headers as Record<string, string> | undefined)?.Range
    // No Range header = the whole-file GET `residentIfSmall` issues. Logged as `whole` so a
    // test can tell "read in one request" from "read in one ranged request".
    if (header === undefined) {
      log.whole++
      return new Response(data.slice(), { status: 200 })
    }
    const m = /bytes=(\d+)-(\d+)/.exec(header)!
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), data.byteLength - 1)
    log.ranges.push([start, end])
    log.bytes += end - start + 1
    return new Response(data.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${reportedTotal}` },
    })
  }) as unknown as typeof globalThis.fetch
}

describe('RangeReader — S-100 over HTTP range', () => {
  it('learns the size from the probe Content-Range', async () => {
    const data = fileBytes('sb_v0_symtab.h5')
    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
    const rr = await RangeReader.open('http://x/a.h5', { fetch: rangeFetch(data, log) })
    expect(rr.byteLength).toBe(data.byteLength)
    expect(log.ranges[0]).toEqual([0, 0]) // the 1-byte probe
  })

  it('reads the SAME grid + geometry as the whole-buffer path, over ranged fetches only', async () => {
    const data = fileBytes('s111_dcf2.h5')
    // ground truth via the buffer path
    const want = await readS102Coverage(await openHdf5(data.buffer.slice(0)))

    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
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
    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
    await expect(
      RangeReader.open('http://x/a.h5', { fetch: rangeFetch(data, log, true) }),
    ).rejects.toThrow(/206|Range/)
  })

  // A real browser's `fetch` is a WebIDL "legacy platform object" operation: calling it
  // via property access (`window.fetch(url)`, `globalThis.fetch(url)`) passes the owning
  // object as `this`; calling a REFERENCE pulled into a local variable (`const f =
  // globalThis.fetch; f(url)`) does not — `this` is `undefined` at that call site — and the
  // browser throws "Illegal invocation". Node/Bun's fetch has no such check, so a Node test
  // run never caught `RangeReader.open()` (no injected `opts.fetch`) doing exactly that. The
  // stub below is a RAW (unbound) function assigned directly as `globalThis.fetch` — the
  // same shape a real Window exposes — that fails unless invoked with `this === globalThis`,
  // faithfully reproducing the property-access-vs-bare-call distinction without needing a
  // real browser.
  it('open() with no injected fetch does not detach globalThis.fetch (browser Illegal-invocation regression)', async () => {
    const realFetch = globalThis.fetch
    const backing = rangeFetch(fileBytes('sb_v0_symtab.h5'), { ranges: [], bytes: 0, whole: 0 })
    // @ts-expect-error — stubbing the global for this one assertion
    globalThis.fetch = function (this: unknown, url: string, init?: RequestInit) {
      if (this !== globalThis)
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      return backing(url, init)
    }
    try {
      await expect(RangeReader.open('http://x/a.h5')).resolves.toBeInstanceOf(RangeReader)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// ── A cell small enough to GET whole is GOT whole (#1505) ─────────────────────
//
// Ranging a small cell is a pure loss and it was measured as one: a real 4.5 MB NOAA S-102
// cell cost 2 100 ms as ranged requests and pulled 4 608 KiB of its 4 608 KiB, against a
// 125 ms whole-file GET. An unwindowed coverage read touches every chunk, so there was
// nothing for the range machinery to skip — only round trips for it to pay.
describe('the whole-file shortcut for a small cell (#1505)', () => {
  it('reads a small cell in ONE unranged GET, and only the probe is ranged', async () => {
    const data = fileBytes('s111_dcf2.h5')
    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
    const rr = await RangeReader.open('http://x/currents.h5', { fetch: rangeFetch(data, log) })
    const reader = await rr.residentIfSmall()

    expect(reader, 'a small cell must not be served by the ranged reader').not.toBe(rr)
    expect(log.whole, 'exactly one whole-file GET').toBe(1)
    expect(log.ranges, 'and nothing ranged beyond the size probe').toEqual([[0, 0]])
    expect(reader.byteLength).toBe(data.byteLength)
  })

  it('the shortcut changes no VALUES — same grid as the ranged read, cell for cell', async () => {
    const data = fileBytes('s111_dcf2.h5')
    const ranged = await readS102Coverage(
      await openHdf5Range(
        await RangeReader.open('http://x/a.h5', {
          fetch: rangeFetch(data, { ranges: [], bytes: 0, whole: 0 }),
        }),
      ),
    )
    const whole = await readS102Coverage(
      await openHdf5Range(
        await (
          await RangeReader.open('http://x/a.h5', {
            fetch: rangeFetch(data, { ranges: [], bytes: 0, whole: 0 }),
          })
        ).residentIfSmall(),
      ),
    )
    expect(whole.gridOrigin).toEqual(ranged.gridOrigin)
    expect([...whole.bands[0]!.values]).toEqual([...ranged.bands[0]!.values])
    expect([...whole.bands[1]!.values]).toEqual([...ranged.bands[1]!.values])
  })

  it('a LARGE cell stays ranged — the shortcut is a size decision, not a default', async () => {
    // The fixture is tiny; the probe REPORTS 9 MB, which is what the decision reads. Without
    // this the threshold would be untestable without committing an 8 MB binary, and an
    // untested threshold is one that can silently become "always".
    const data = fileBytes('s111_dcf2.h5')
    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
    const rr = await RangeReader.open('http://x/big.h5', {
      fetch: rangeFetch(data, log, false, 9 * 1024 * 1024),
    })
    expect(await rr.residentIfSmall(), 'a 9 MB cell must keep streaming').toBe(rr)
    expect(log.whole, 'and must not have been pulled whole to find that out').toBe(0)
  })

  it('falls back to the ranged reader when the whole-file GET fails', async () => {
    // A slow read beats a failed one, and the probe has just proved ranging works here.
    const data = fileBytes('s111_dcf2.h5')
    const log: FetchLog = { ranges: [], bytes: 0, whole: 0 }
    const inner = rangeFetch(data, log)
    const flaky = (async (url: string, init?: RequestInit) => {
      if ((init?.headers as Record<string, string> | undefined)?.Range === undefined)
        return new Response('nope', { status: 500 })
      return inner(url, init)
    }) as unknown as typeof globalThis.fetch
    const rr = await RangeReader.open('http://x/a.h5', { fetch: flaky })
    expect(await rr.residentIfSmall()).toBe(rr)
    // And it still reads correctly over that fallback.
    const got = await readS102Coverage(await openHdf5Range(rr))
    expect(got.bands.length).toBeGreaterThan(0)
  })
})

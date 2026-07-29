// ═══ HDF5 ByteReader over HTTP range requests (ADR-0010 increment 4) ═══
//
// A `ByteReader` that fetches `[offset, offset+length)` with an HTTP `Range` header,
// so a large/remote S-100 cell streams: the reader pulls the superblock + object
// headers + b-tree, then ONLY the chunks a read touches — never the whole file. The
// Cursor already block-caches (256 KB) and coalesces contiguous misses into one
// `read`, so this stays a thin fetch wrapper (no second cache). Size is learned up
// front from the `Content-Range` total of a 1-byte probe (HEAD is not always allowed;
// a range GET both proves the server honours ranges and reports the total).
//
// CORS still applies (a browser fetch) — NOAA's S-100 S3 buckets are CORS-blocked, so
// point this at your CORS-proxy/mirror, not the bucket directly (see the recipes doc).

import { BufferReader, Hdf5Error, type ByteReader } from './bytes'

export interface RangeReaderOptions {
  /** Injectable fetch (tests / a custom-header proxy client). Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/** At or below this total size a cell is read in ONE request instead of ranged.
 *
 *  MEASURED, on a real 4.5 MB NOAA S-102 cell over the same link, in the same run:
 *
 *      whole-file GET                    125 ms
 *      ranged read (bytes it needed)   2 100 ms   — and it pulled 4 608 KiB of the 4 608 KiB
 *
 *  The ranged read fetched the ENTIRE file and paid ten-plus serial round trips to do it,
 *  because an unwindowed coverage read touches every chunk. That is the common case for
 *  S-102: one survey grid, no forecast axis to skip.
 *
 *  The crossover is algebra, not taste. Ranged costs `K·RTT + needed/T`, whole costs
 *  `RTT + total/T`, so whole wins while `(K−1)·RTT > (total − needed)/T`. `K` is never
 *  below ~6 (probe → superblock → root group → object header → b-tree levels → chunks — a
 *  chain where each address is only known once its predecessor is parsed), and this repo's
 *  own `bbox-window.test.ts` measures the best case for ranging at the DEFAULT block size:
 *  a 10 % viewport window over a 3.9 MB file still transfers 80 % of it across 11 requests.
 *  So `total − needed` is small for anything this size and the latency term dominates on
 *  every link — the slower the link, the smaller the file this fires on matters, which is
 *  why the bound is 8 MB rather than "whenever it looks like most of the file".
 *
 *  Above it, ranging keeps its point: a multi-timestep S-111 cell reads one forecast group
 *  out of dozens, and a windowed read of a large S-102 survey skips most of the grid. */
const WHOLE_FILE_MAX = 8 * 1024 * 1024

export class RangeReader implements ByteReader {
  private constructor(
    readonly url: string,
    readonly byteLength: number,
    private readonly doFetch: typeof globalThis.fetch,
  ) {}

  /** Open a range reader — a 1-byte range probe learns the total size and confirms the
   *  server honours `Range` (a `200` full-body response is rejected: without range
   *  support every `read` would pull the whole file, defeating the point). */
  static async open(url: string, opts?: RangeReaderOptions): Promise<RangeReader> {
    // `.bind(globalThis)`: a bare `globalThis.fetch` reference invoked off this local const
    // loses its receiver — in a real browser that throws "TypeError: Failed to execute
    // 'fetch' on 'Window': Illegal invocation" (a WebIDL branded-`this` check that Node/Bun's
    // fetch doesn't enforce, so this stayed invisible to every Node-run test). Same fix as
    // sprite-atlas-host.ts's `opts.fetch ?? globalThis.fetch.bind(globalThis)`.
    const doFetch = opts?.fetch ?? globalThis.fetch.bind(globalThis)
    const res = await doFetch(url, { headers: { Range: 'bytes=0-0' } })
    if (res.status !== 206)
      throw new Hdf5Error(
        `range probe: expected 206 Partial Content, got ${res.status} — the server must ` +
          `honour HTTP Range (put a range-capable proxy/CDN in front of it)`,
      )
    const total = parseContentRangeTotal(res.headers.get('content-range'))
    if (total === null || total <= 0)
      throw new Hdf5Error('range probe: no usable Content-Range total in the 206 response')
    // Drain the 1-byte body so the connection can be reused.
    await res.arrayBuffer()
    return new RangeReader(url, total, doFetch)
  }

  /** The reader a caller should actually parse through: `this` for a large cell, or a
   *  RESIDENT reader over the whole file for one small enough that a single GET beats the
   *  round trips a ranged parse needs (see `WHOLE_FILE_MAX`).
   *
   *  Deliberately NOT folded into `open()`: `RangeReader` stays exactly what it says it is —
   *  a `ByteReader` over HTTP Range — and this policy sits where the caller can see it. The
   *  Range probe in `open()` still runs either way, so a server that does not honour Range
   *  is still rejected loudly rather than silently whole-file'd.
   *
   *  Falls back to `this` if the whole-file GET fails or comes back short: a slow path is a
   *  better outcome than a failed read, and the ranged path is known to work here (the probe
   *  just proved it). */
  async residentIfSmall(): Promise<ByteReader> {
    if (this.byteLength > WHOLE_FILE_MAX) return this
    try {
      const res = await this.doFetch(this.url)
      if (!res.ok) return this
      const buf = new Uint8Array(await res.arrayBuffer())
      return buf.byteLength === this.byteLength ? new BufferReader(buf) : this
    } catch {
      return this
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0)
    if (offset < 0 || offset + length > this.byteLength)
      throw new Hdf5Error(
        `range read out of file (${offset}+${length} / ${this.byteLength})`,
        offset,
      )
    const res = await this.doFetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    })
    if (res.status !== 206)
      throw new Hdf5Error(
        `range read ${offset}-${offset + length - 1}: expected 206, got ${res.status}`,
      )
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < length)
      throw new Hdf5Error(
        `range read ${offset}-${offset + length - 1}: server returned ${buf.byteLength} B, need ${length}`,
      )
    return buf.byteLength === length ? buf : buf.subarray(0, length)
  }
}

/** Parse the total from a `Content-Range: bytes 0-0/12345` header → 12345 (null if the
 *  size is unknown, `*`, or malformed). */
function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null
  const m = /\/\s*(\d+)\s*$/.exec(header)
  return m ? Number(m[1]) : null
}

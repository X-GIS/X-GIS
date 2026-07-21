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

import { Hdf5Error, type ByteReader } from './bytes'

export interface RangeReaderOptions {
  /** Injectable fetch (tests / a custom-header proxy client). Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
}

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
    const doFetch = opts?.fetch ?? globalThis.fetch
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

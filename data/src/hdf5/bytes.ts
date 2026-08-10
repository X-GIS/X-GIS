// ═══ HDF5 subset reader — byte cursor + loud error (#1158 GAP-1 INC-A) ═══
//
// A little-endian `DataView` cursor with the exact primitive reads the HDF5
// File Format Spec needs (u8/u16/u32/u64, i32, f32/f64, offset/length words,
// signature match). Zero-dep by construction (DataView is universal) so the
// reader is runtime-promotable without a rewrite — the same both-ends discipline
// as `pipeline/src/odb/format.ts`.
//
// LOUD FAILURE IS THE CONTRACT (design §8.1 / A1): every out-of-subset construct
// throws an `Hdf5Error` naming the construct AND the file offset. A silent
// mis-parse of navigation-adjacent data is the one unacceptable outcome, so there
// is no "best effort" path anywhere below.

/** A source-attributable HDF5 parse error. Always names the construct + the file
 *  offset it was found at, so an out-of-subset file fails with a fixable message
 *  rather than a wrong grid. */
export class Hdf5Error extends Error {
  constructor(
    message: string,
    /** File byte offset the failure was found at (−1 when not offset-bound). */
    readonly offset: number = -1,
  ) {
    super(offset >= 0 ? `[hdf5 @0x${offset.toString(16)}] ${message}` : `[hdf5] ${message}`)
    this.name = 'Hdf5Error'
  }
}

/** All-0xFF address = the HDF5 "undefined address" sentinel. Represented as −1
 *  here so callers test `addr < 0` (never an exact 2^64−1 float compare). */
export const UNDEFINED_ADDR = -1

/** An async byte source for the reader (ADR-0010 increment 4). The reader reads
 *  small scattered metadata (superblock / object headers / b-tree / heaps) and large
 *  data chunks; a `ByteReader` lets those come from a whole in-memory buffer OR from
 *  HTTP range requests, so a large/global grid fetches only the chunks a viewport
 *  needs instead of the whole file. `read` MAY over-fetch (block-aligned) internally;
 *  it MUST return exactly the requested `[offset, offset+length)` slice. */
export interface ByteReader {
  readonly byteLength: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** A `ByteReader` over a whole resident buffer — the local / whole-file path
 *  (backward-compatible with `openHdf5(ArrayBuffer)`; `Cursor.ensure` is a no-op
 *  because every byte is already resident). */
export class BufferReader implements ByteReader {
  private readonly u8: Uint8Array
  constructor(buf: ArrayBuffer | Uint8Array) {
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  }
  get byteLength(): number {
    return this.u8.byteLength
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.u8.byteLength)
      throw new Hdf5Error(`read out of range (${offset}+${length} / ${this.u8.byteLength})`, offset)
    return this.u8.subarray(offset, offset + length)
  }
}

/** Cursor block size — a read faults in the 256 KB block(s) covering its range. Large
 *  enough that clustered HDF5 metadata (superblock + object headers + b-tree + heaps)
 *  usually costs one or two range requests; small enough that a scattered chunk index
 *  does not drag the whole file. A `BufferReader` serves every block from memory. */
const BLOCK = 1 << 18

/** Largest coalesced run one `ensureAll` request may cover (32 blocks = 8 MB). A whole
 *  dataset's chunks are usually CONTIGUOUS in the file, so without a cap the batch would
 *  collapse into one enormous request that no pool can overlap — and a stalled fetch of it
 *  has nothing else in flight to hide behind. Splitting at 8 MB keeps the request count
 *  small while leaving the pool something to parallelise. */
const MAX_RUN_BLOCKS = 32

/** How many range requests `ensureAll` keeps in flight. Six is the per-host connection
 *  budget a browser gives HTTP/1.1 — asking for more would queue in the network stack
 *  rather than overlap, and would look like a win only where the transport is HTTP/2. */
const MAX_IN_FLIGHT = 6

/** A byte range to fault in. */
export interface ByteRange {
  offset: number
  length: number
}

/** Little-endian byte cursor over a `ByteReader`. `O` (size of offsets) and `L` (size
 *  of lengths) come from the superblock; address/length words are read at those widths.
 *  Absolute file offsets throughout. Synchronous reads operate over RESIDENT blocks:
 *  a caller `await`s `ensure(addr, len)` before the sync reads at a cross-region seek
 *  (object header / b-tree node / chunk); a sync read of a non-resident byte is a
 *  reader bug (loud throw), never a silent mis-parse. */
export class Cursor {
  pos = 0
  /** Size of offsets (address word width) — 2/4/8. Set from the superblock. */
  O = 8
  /** Size of lengths (length word width) — 2/4/8. Set from the superblock. */
  L = 8
  private readonly blocks = new Map<number, Uint8Array>()

  /** `block` = fault-in granularity (default 256 KB). A smaller block trades more range
   *  requests for less over-fetch on a sparse read; exposed for tuning + tests. */
  constructor(
    readonly reader: ByteReader,
    private readonly block: number = BLOCK,
  ) {}

  get byteLength(): number {
    return this.reader.byteLength
  }

  /** Fault-in every block covering `[offset, offset+length)` so the following sync
   *  reads are resident. A no-op for already-resident ranges (recursion + re-visits
   *  cost nothing). Missing blocks are fetched in ONE coalesced `read` per gap. */
  async ensure(offset: number, length: number): Promise<void> {
    if (length <= 0) return
    const first = Math.floor(offset / this.block)
    const last = Math.floor((offset + length - 1) / this.block)
    let runStart = -1
    for (let b = first; b <= last + 1; b++) {
      const missing = b <= last && !this.blocks.has(b)
      if (missing && runStart < 0) runStart = b
      else if (!missing && runStart >= 0) {
        const start = runStart * this.block
        const end = Math.min(b * this.block, this.reader.byteLength)
        const bytes = await this.reader.read(start, end - start)
        for (let k = runStart; k < b; k++)
          this.blocks.set(
            k,
            bytes.subarray((k - runStart) * this.block, (k - runStart + 1) * this.block),
          )
        runStart = -1
      }
    }
  }

  /** Fault in every block covering ANY of `ranges`, coalesced across the whole set and
   *  fetched CONCURRENTLY. The batched sibling of `ensure` — same residency effect, one
   *  round-trip cost instead of one per range.
   *
   *  `ensure` can only see the range in front of it, so a caller that walks a list of
   *  ranges pays a serial round trip for each: a real 4.5 MB NOAA S-102 cell read as 18
   *  back-to-back 256 KB requests took 2977 ms against a 125 ms whole-file GET — a 24×
   *  penalty that is entirely latency, not bandwidth (measured over the same link: 65 ms
   *  RTT × 18 hops in series, zero overlap). The chunk list a dataset read walks is known
   *  in full BEFORE the first fetch, so nothing about it required serialising.
   *
   *  Coalescing is what makes this more than a thread pool: adjacent chunks share blocks
   *  and sit next to each other in the file, so the union usually collapses to a handful
   *  of runs. It stays SELECTIVE — only blocks some range actually touches are fetched, so
   *  a bbox-windowed read still skips the rest of the file (ADR-0010 §4).
   *
   *  Carries the same residency GUARANTEE as `ensure` over the union of `ranges`, so a
   *  caller that batches here does not also have to `ensure` each range afterwards. */
  async ensureAll(ranges: readonly ByteRange[]): Promise<void> {
    const missing = new Set<number>()
    for (const r of ranges) {
      if (r.length <= 0) continue
      const last = Math.floor((r.offset + r.length - 1) / this.block)
      for (let b = Math.floor(r.offset / this.block); b <= last; b++)
        if (!this.blocks.has(b)) missing.add(b)
    }
    if (missing.size === 0) return
    const sorted = [...missing].sort((a, b) => a - b)
    const runs: Array<[number, number]> = []
    let start = sorted[0]!
    let prev = start
    for (let i = 1; i < sorted.length; i++) {
      const b = sorted[i]!
      if (b === prev + 1 && b - start < MAX_RUN_BLOCKS) {
        prev = b
        continue
      }
      runs.push([start, prev])
      start = b
      prev = b
    }
    runs.push([start, prev])

    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < runs.length; i = next++) {
        const [first, last] = runs[i]!
        const from = first * this.block
        const to = Math.min((last + 1) * this.block, this.reader.byteLength)
        const bytes = await this.reader.read(from, to - from)
        for (let k = first; k <= last; k++)
          this.blocks.set(k, bytes.subarray((k - first) * this.block, (k - first + 1) * this.block))
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, runs.length) }, () => worker()))
  }

  seek(pos: number): this {
    if (pos < 0 || pos > this.reader.byteLength)
      throw new Hdf5Error(`seek out of range (${pos} / ${this.reader.byteLength})`, pos)
    this.pos = pos
    return this
  }

  skip(n: number): this {
    return this.seek(this.pos + n)
  }

  private bounds(need: number, what: string): void {
    if (this.pos + need > this.reader.byteLength)
      throw new Hdf5Error(
        `truncated file: ${what} needs ${need} B, ${this.reader.byteLength - this.pos} left`,
        this.pos,
      )
  }

  /** The resident byte at absolute `p` — throws if the block was not `ensure`d. */
  private at(p: number): number {
    const blk = this.blocks.get(Math.floor(p / this.block))
    if (!blk) throw new Hdf5Error(`byte @0x${p.toString(16)} not resident — ensure() first`, p)
    return blk[p % this.block]!
  }

  /** A little-endian DataView + local offset for a `size`-byte read at `pos`, resident.
   *  Fast path: the read lies within ONE block (its own view). Slow path (a read that
   *  straddles a block boundary): assemble the bytes into a small scratch view. */
  private viewAt(size: number): { view: DataView; off: number } {
    const p = this.pos
    const blkIdx = Math.floor(p / this.block)
    const local = p % this.block
    const blk = this.blocks.get(blkIdx)
    if (!blk) throw new Hdf5Error(`read @0x${p.toString(16)} not resident — ensure() first`, p)
    if (local + size <= blk.byteLength)
      return { view: new DataView(blk.buffer, blk.byteOffset + local, size), off: 0 }
    const scratch = new Uint8Array(size)
    for (let i = 0; i < size; i++) scratch[i] = this.at(p + i)
    return { view: new DataView(scratch.buffer), off: 0 }
  }

  u8(): number {
    this.bounds(1, 'u8')
    return this.at(this.pos++)
  }
  peekU8(at = this.pos): number {
    return this.at(at)
  }
  u16(): number {
    this.bounds(2, 'u16')
    const { view, off } = this.viewAt(2)
    this.pos += 2
    return view.getUint16(off, true)
  }
  u32(): number {
    this.bounds(4, 'u32')
    const { view, off } = this.viewAt(4)
    this.pos += 4
    return view.getUint32(off, true)
  }
  i32(): number {
    this.bounds(4, 'i32')
    const { view, off } = this.viewAt(4)
    this.pos += 4
    return view.getInt32(off, true)
  }
  f32(): number {
    this.bounds(4, 'f32')
    const { view, off } = this.viewAt(4)
    this.pos += 4
    return view.getFloat32(off, true)
  }
  f64(): number {
    this.bounds(8, 'f64')
    const { view, off } = this.viewAt(8)
    this.pos += 8
    return view.getFloat64(off, true)
  }

  /** Read an unsigned integer of `size` bytes (2/4/8) as a JS number. HDF5 in-file
   *  offsets/lengths in the corpus stay well under 2^53, so an 8-byte word is
   *  assembled as lo + hi·2^32 losslessly; an all-0xFF word (the "undefined"
   *  sentinel) returns UNDEFINED_ADDR (−1). */
  uint(size: number): number {
    this.bounds(size, `uint${size * 8}`)
    let allFF = true
    for (let i = 0; i < size; i++) if (this.at(this.pos + i) !== 0xff) allFF = false
    if (allFF && size >= 4) {
      this.pos += size
      return UNDEFINED_ADDR
    }
    let lo = 0
    let hi = 0
    for (let i = 0; i < size; i++) {
      const b = this.at(this.pos + i)
      if (i < 4) lo |= b << (8 * i)
      else hi |= b << (8 * (i - 4))
    }
    this.pos += size
    // >>>0 makes the low word unsigned; hi carries bytes 4..7.
    return (lo >>> 0) + hi * 0x1_0000_0000
  }

  /** An address word (offset-size). */
  offset(): number {
    return this.uint(this.O)
  }
  /** A length word (length-size). */
  length(): number {
    return this.uint(this.L)
  }

  /** Read `n` raw bytes as a fresh Uint8Array (copy — never a view alias). Assembled
   *  across resident blocks by contiguous segment copies (a chunk that spans blocks). */
  bytes(n: number): Uint8Array {
    this.bounds(n, `${n} bytes`)
    const out = new Uint8Array(n)
    let done = 0
    while (done < n) {
      const p = this.pos + done
      const blk = this.blocks.get(Math.floor(p / this.block))
      if (!blk) throw new Hdf5Error(`bytes @0x${p.toString(16)} not resident — ensure() first`, p)
      const local = p % this.block
      const take = Math.min(n - done, blk.byteLength - local)
      out.set(blk.subarray(local, local + take), done)
      done += take
    }
    this.pos += n
    return out
  }

  /** Read `n` bytes at absolute `offset` (resident) as a fresh copy WITHOUT moving
   *  `pos` — the random-access sibling of `bytes()`, for parsers that read a field at
   *  a computed offset then continue where they were. */
  sliceAt(offset: number, n: number): Uint8Array {
    const save = this.pos
    this.pos = offset
    const out = this.bytes(n)
    this.pos = save
    return out
  }

  /** A NUL-terminated (or fixed-`max`) ASCII string; advances past the NUL. Used
   *  for link names / attribute names — always ASCII in the S-100 corpus. */
  cstr(max = 0x10000): string {
    const start = this.pos
    let end = start
    const len = this.reader.byteLength
    while (end < len && this.at(end) !== 0 && end - start < max) end++
    const raw = new Uint8Array(end - start)
    for (let i = 0; i < raw.length; i++) raw[i] = this.at(start + i)
    const s = new TextDecoder().decode(raw)
    this.pos = end < len ? end + 1 : end
    return s
  }

  /** Assert an N-byte ASCII signature at the current position (advances past it). */
  signature(sig: string, what: string): void {
    const got = new TextDecoder().decode(this.bytes(sig.length))
    if (got !== sig)
      throw new Hdf5Error(
        `${what}: expected signature "${sig}", got "${got}"`,
        this.pos - sig.length,
      )
  }

  /** Align the cursor UP to the next multiple of `n` (8-byte message alignment). */
  align(n: number): this {
    const rem = this.pos % n
    if (rem !== 0) this.pos += n - rem
    return this
  }
}

/** Decode a fixed-length HDF5 string field: bytes up to the first NUL (or the full
 *  width if unterminated), ASCII/UTF-8. Trailing NULs / spaces trimmed. */
export function decodeFixedString(bytes: Uint8Array): string {
  let end = bytes.length
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0) {
      end = i
      break
    }
  return new TextDecoder().decode(bytes.subarray(0, end)).replace(/[\s\0]+$/, '')
}

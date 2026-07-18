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

/** Little-endian byte cursor over the whole file buffer. `O` (size of offsets)
 *  and `L` (size of lengths) come from the superblock; address/length words are
 *  read at those widths. Absolute file offsets throughout (base address is added
 *  by the caller — 0 for every userblock-free file in the corpus). */
export class Cursor {
  readonly view: DataView
  readonly u8arr: Uint8Array
  pos = 0
  /** Size of offsets (address word width) — 2/4/8. Set from the superblock. */
  O = 8
  /** Size of lengths (length word width) — 2/4/8. Set from the superblock. */
  L = 8

  constructor(readonly buf: ArrayBuffer) {
    this.view = new DataView(buf)
    this.u8arr = new Uint8Array(buf)
  }

  get byteLength(): number {
    return this.buf.byteLength
  }

  seek(pos: number): this {
    if (pos < 0 || pos > this.buf.byteLength)
      throw new Hdf5Error(`seek out of range (${pos} / ${this.buf.byteLength})`, pos)
    this.pos = pos
    return this
  }

  skip(n: number): this {
    return this.seek(this.pos + n)
  }

  private bounds(need: number, what: string): void {
    if (this.pos + need > this.buf.byteLength)
      throw new Hdf5Error(
        `truncated file: ${what} needs ${need} B, ${this.buf.byteLength - this.pos} left`,
        this.pos,
      )
  }

  u8(): number {
    this.bounds(1, 'u8')
    return this.view.getUint8(this.pos++)
  }
  peekU8(at = this.pos): number {
    return this.view.getUint8(at)
  }
  u16(): number {
    this.bounds(2, 'u16')
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  u32(): number {
    this.bounds(4, 'u32')
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  i32(): number {
    this.bounds(4, 'i32')
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  f32(): number {
    this.bounds(4, 'f32')
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }
  f64(): number {
    this.bounds(8, 'f64')
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }

  /** Read an unsigned integer of `size` bytes (2/4/8) as a JS number. HDF5 in-file
   *  offsets/lengths in the corpus stay well under 2^53, so an 8-byte word is
   *  assembled as lo + hi·2^32 losslessly; an all-0xFF word (the "undefined"
   *  sentinel) returns UNDEFINED_ADDR (−1). */
  uint(size: number): number {
    this.bounds(size, `uint${size * 8}`)
    let allFF = true
    for (let i = 0; i < size; i++) if (this.u8arr[this.pos + i] !== 0xff) allFF = false
    if (allFF && size >= 4) {
      this.pos += size
      return UNDEFINED_ADDR
    }
    let lo = 0
    let hi = 0
    for (let i = 0; i < size; i++) {
      const b = this.u8arr[this.pos + i]!
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

  /** Read `n` raw bytes as a fresh Uint8Array (copy — never a view alias). */
  bytes(n: number): Uint8Array {
    this.bounds(n, `${n} bytes`)
    const out = this.u8arr.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** A NUL-terminated (or fixed-`max`) ASCII string; advances past the NUL. Used
   *  for link names / attribute names — always ASCII in the S-100 corpus. */
  cstr(max = 0x10000): string {
    const start = this.pos
    let end = start
    while (end < this.buf.byteLength && this.u8arr[end] !== 0 && end - start < max) end++
    const s = new TextDecoder().decode(this.u8arr.subarray(start, end))
    this.pos = end < this.buf.byteLength ? end + 1 : end
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

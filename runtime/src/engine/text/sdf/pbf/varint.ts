// Minimal protobuf decoder for the glyphs.proto schema. Hand-rolled to
// avoid adding a runtime dependency on the `pbf` package for one schema.
//
// Wire types used by glyphs.proto:
//   0 = varint     (uint32, sint32 with zigzag)
//   2 = length-delimited (string, bytes, embedded message)
// We implement just those plus a generic skip for forward-compat.

export class PbfReader {
  pos = 0
  readonly buf: Uint8Array
  readonly len: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.len = buf.length
  }

  readTag(): { field: number; wire: number } {
    const v = this.readVarint()
    return { field: v >>> 3, wire: v & 7 }
  }

  readVarint(): number {
    let result = 0
    let shift = 0
    while (this.pos < this.len) {
      const b = this.buf[this.pos++]!
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return result >>> 0
      shift += 7
      if (shift >= 32) {
        while (this.pos < this.len && (this.buf[this.pos++]! & 0x80) !== 0) { /* drain */ }
        return result >>> 0
      }
    }
    return result >>> 0
  }

  readSignedVarint(): number {
    const v = this.readVarint()
    return (v >>> 1) ^ -(v & 1)
  }

  readBytes(len: number): Uint8Array {
    const start = this.pos
    this.pos += len
    return this.buf.subarray(start, this.pos)
  }

  readString(len: number): string {
    return new TextDecoder().decode(this.readBytes(len))
  }

  skip(wire: number): void {
    switch (wire) {
      case 0: this.readVarint(); return
      case 1: this.pos += 8; return
      case 2: { const len = this.readVarint(); this.pos += len; return }
      case 5: this.pos += 4; return
      default: throw new Error(`PbfReader: unknown wire type ${wire}`)
    }
  }

  readMessage<T>(fn: (r: PbfReader, end: number) => T): T {
    const len = this.readVarint()
    const end = this.pos + len
    return fn(this, end)
  }
}

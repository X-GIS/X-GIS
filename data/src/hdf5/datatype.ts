// ═══ HDF5 subset reader — datatype message (class 0/1/3/6/8) ═══
//
// Parses a Datatype message into a decode descriptor. SUBSET (A1), little-endian
// only:
//   • class 0 fixed-point — UNSIGNED u8/u16/u32 (signed / big-endian → hard error)
//   • class 1 float       — IEEE f32/f64      (big-endian → hard error)
//   • class 3 string      — FIXED length
//   • class 6 compound    — member offsets read from the message, never assumed packed
//   • class 8 enum        — decoded as its integer base type
// classes time(2) / bitfield(4) / opaque(5) / reference(7) / vlen(9) / array(10)
// are OUT — hard error naming the class + file offset.
//
// The cursor is left positioned at the END of the datatype message so a compound
// can parse members sequentially and a caller can chain.

import { Cursor, Hdf5Error } from './bytes'

export type Datatype =
  // Fixed-point. `signed` + `le` are RECORDED here (structural), not policed: the
  // GRID band path enforces the A1 subset (unsigned + little-endian only), while a
  // metadata ATTRIBUTE may legitimately be a signed int (e.g. horizontalCRS i32).
  | { kind: 'int'; size: number; signed: boolean; le: boolean }
  | { kind: 'float'; size: number; le: boolean }
  | { kind: 'string'; size: number }
  | { kind: 'enum'; size: number; base: Datatype }
  | { kind: 'compound'; size: number; members: CompoundMember[] }
  // Variable-length. On-disk element = a global-heap ID (length + collection
  // address + object index). READ ONLY from an attribute (metadata provenance);
  // a vlen GRID band is a hard error (A1 / neg_vlen) — enforced in dataset.ts.
  | { kind: 'vlen'; size: number; isString: boolean; base: Datatype }

export interface CompoundMember {
  name: string
  /** Byte offset of this member within one element (read from the message). */
  offset: number
  type: Datatype
}

const CLASS_NAME: Record<number, string> = {
  2: 'time',
  4: 'bitfield',
  5: 'opaque',
  7: 'reference',
  9: 'variable-length (vlen)',
  10: 'array',
}

export function parseDatatype(c: Cursor, start: number): Datatype {
  c.seek(start)
  // Class-and-version byte: CLASS = low nibble (bits 0-3), VERSION = high nibble
  // (bits 4-7). (The reverse gives version 9 on a real vlen datatype — the bug.)
  const classAndVersion = c.u8()
  const version = (classAndVersion >> 4) & 0x0f
  const cls = classAndVersion & 0x0f
  const bits0 = c.u8()
  const bits1 = c.u8()
  c.u8() // bit field 2
  const size = c.u32()

  switch (cls) {
    case 0: {
      // fixed-point: bit offset(2) + bit precision(2). Endianness/sign RECORDED
      // (the grid path enforces LE + unsigned; a metadata attr may be signed i32).
      c.u16()
      c.u16()
      return { kind: 'int', size, signed: (bits0 & 0x08) !== 0, le: (bits0 & 0x01) === 0 }
    }
    case 1: {
      // floating-point: bit offset(2) precision(2) exp-loc(1) exp-size(1) mant-loc(1) mant-size(1) exp-bias(4)
      c.skip(12)
      return { kind: 'float', size, le: (bits0 & 0x01) === 0 }
    }
    case 3: {
      // fixed-length string — padding type / charset live in bits0 (not needed here).
      return { kind: 'string', size }
    }
    case 6: {
      const numMembers = bits0 | (bits1 << 8)
      const members: CompoundMember[] = []
      for (let i = 0; i < numMembers; i++) members.push(parseCompoundMember(c, version, size))
      return { kind: 'compound', size, members }
    }
    case 8: {
      const numMembers = bits0 | (bits1 << 8)
      // base datatype follows the 8-byte header (leaves the cursor after it)
      const base = parseDatatype(c, c.pos)
      // member names (null-terminated; v1/v2 padded to 8, v3 not) then values
      for (let i = 0; i < numMembers; i++) {
        const nameStart = c.pos
        c.cstr()
        if (version < 3) c.seek(nameStart + Math.ceil((c.pos - nameStart) / 8) * 8)
      }
      c.skip(numMembers * base.size) // enum values, base-sized
      return { kind: 'enum', size, base }
    }
    case 9: {
      // variable-length: bits0 bits 0-3 = 0 sequence / 1 string. Base type follows
      // the 8-byte header. Decoded ONLY for attributes (via the global heap); a
      // vlen grid band is rejected downstream (A1). `size` = on-disk ID size.
      const isString = (bits0 & 0x0f) === 1
      const base = parseDatatype(c, c.pos)
      return { kind: 'vlen', size, isString, base }
    }
    default:
      throw new Hdf5Error(
        `datatype class ${cls} (${CLASS_NAME[cls] ?? 'unknown'}) — outside the INC-A subset`,
        start,
      )
  }
}

function parseCompoundMember(c: Cursor, version: number, totalSize: number): CompoundMember {
  const nameStart = c.pos
  const name = c.cstr()
  if (version === 1 || version === 2) {
    // name is padded to a multiple of 8 bytes
    c.seek(nameStart + Math.ceil((c.pos - nameStart) / 8) * 8)
  }
  let offset: number
  if (version === 1) {
    offset = c.u32()
    c.skip(1 + 3 + 4 + 4 + 16) // dimensionality + reserved + permutation + reserved + 4 dim sizes
  } else if (version === 2) {
    offset = c.u32()
  } else {
    // version 3: offset stored in the minimum bytes needed to hold `totalSize`
    const nbytes = Math.max(1, Math.ceil(Math.log2(totalSize + 1) / 8))
    offset = c.uint(nbytes)
  }
  const type = parseDatatype(c, c.pos)
  return { name, offset, type }
}

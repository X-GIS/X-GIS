// ═══ HDF5 subset reader — object header (v1 + v2) ═══
//
// Parses a Data Object Header at a given address into a flat list of raw
// messages (type + flags + body span), transparently following Object Header
// Continuation (0x10) blocks. Version 1 (earliest format) and version 2 ("OHDR",
// 1.8 latest) are both in the subset. Shared messages (flag bit 1) are OUT (A1) —
// a loud error, since the shared-message table itself is unsupported.
//
// The KNOWN message-type set lives in messages.ts; here we only need the
// continuation type (0x10) to walk the header. Unknown types are handed back
// verbatim so the caller can apply the must-understand rule at parse time.

import { Cursor, Hdf5Error } from './bytes'

export const MSG = {
  NIL: 0x00,
  DATASPACE: 0x01,
  LINK_INFO: 0x02,
  DATATYPE: 0x03,
  FILL_VALUE_OLD: 0x04,
  FILL_VALUE: 0x05,
  LINK: 0x06,
  LAYOUT: 0x08,
  GROUP_INFO: 0x0a,
  FILTER_PIPELINE: 0x0b,
  ATTRIBUTE: 0x0c,
  OBJECT_HEADER_CONTINUATION: 0x10,
  SYMBOL_TABLE: 0x11,
  OBJECT_MODIFICATION_TIME: 0x12,
  ATTRIBUTE_INFO: 0x15,
} as const

/** Message types the reader understands. An unknown type with the must-understand
 *  flag (bit 3) set is a hard error; otherwise it is skipped (A1). */
const KNOWN = new Set<number>(Object.values(MSG))

const FLAG_SHARED = 0x02
const FLAG_MUST_UNDERSTAND = 0x08

export interface RawMessage {
  type: number
  flags: number
  /** Absolute file offset of the message body. */
  bodyStart: number
  /** Message body size in bytes. */
  bodySize: number
}

interface Region {
  start: number
  end: number
  /** v2 messages carry a 2-byte creation-order field when the OH tracks it. */
  creationOrder: boolean
  v2: boolean
}

/** Parse the object header at `addr` → its messages (continuations inlined). Async:
 *  each header/continuation region is `ensure`d resident before it is walked, so a
 *  range reader fetches only the header blocks (ADR-0010 increment 4). */
export async function parseObjectHeader(c: Cursor, addr: number): Promise<RawMessage[]> {
  if (addr < 0) throw new Hdf5Error('object header at undefined address', addr)
  await c.ensure(addr, Math.min(64, c.byteLength - addr)) // header prefix (v1 16 B / v2 ≤34 B)
  c.seek(addr)
  const first = c.peekU8(addr)
  return first === 0x4f /* 'O' of "OHDR" */ ? parseV2(c, addr) : parseV1(c, addr)
}

// ── Version 1 ────────────────────────────────────────────────────────────────
async function parseV1(c: Cursor, addr: number): Promise<RawMessage[]> {
  c.seek(addr)
  const version = c.u8()
  if (version !== 1) throw new Hdf5Error(`object header: expected version 1, got ${version}`, addr)
  c.u8() // reserved
  const totalMessages = c.u16()
  c.u32() // object reference count
  const chunk0Size = c.u32()
  c.u32() // 4 bytes padding → messages start 8-byte aligned at addr+16
  const regions: Region[] = [
    { start: addr + 16, end: addr + 16 + chunk0Size, creationOrder: false, v2: false },
  ]
  return await walk(c, regions, totalMessages)
}

// ── Version 2 ("OHDR") ───────────────────────────────────────────────────────
async function parseV2(c: Cursor, addr: number): Promise<RawMessage[]> {
  c.seek(addr)
  c.signature('OHDR', 'object header v2')
  const version = c.u8()
  if (version !== 2) throw new Hdf5Error(`object header v2: bad version ${version}`, addr)
  const flags = c.u8()
  if (flags & 0x20) c.skip(16) // access/mod/change/birth times
  if (flags & 0x10) c.skip(4) // max-compact + min-dense attr phase-change
  const chunk0SizeBytes = 1 << (flags & 0x03)
  const chunk0Size = c.uint(chunk0SizeBytes)
  const creationOrder = (flags & 0x04) !== 0
  const start = c.pos
  const regions: Region[] = [{ start, end: start + chunk0Size, creationOrder, v2: true }]
  // total-message count is unknown for v2 (byte-bounded); walk by region bytes.
  return await walk(c, regions, Number.POSITIVE_INFINITY)
}

/** Read messages from a queue of regions, following continuation (0x10) blocks,
 *  until `maxMessages` are read (v1) or every region's bytes are exhausted (v2).
 *  Each region (chunk 0 + every continuation) is `ensure`d resident before it is read. */
async function walk(c: Cursor, regions: Region[], maxMessages: number): Promise<RawMessage[]> {
  const out: RawMessage[] = []
  let qi = 0
  while (qi < regions.length && out.length < maxMessages) {
    const region = regions[qi++]!
    await c.ensure(region.start, region.end - region.start)
    c.seek(region.start)
    while (c.pos + (region.v2 ? 4 : 8) <= region.end && out.length < maxMessages) {
      const msgStart = c.pos
      let type: number
      let size: number
      let flags: number
      if (region.v2) {
        type = c.u8()
        size = c.u16()
        flags = c.u8()
        if (region.creationOrder) c.skip(2)
      } else {
        type = c.u16()
        size = c.u16()
        flags = c.u8()
        c.skip(3) // reserved
      }
      const bodyStart = c.pos
      if (bodyStart + size > region.end) {
        // A trailing NIL/gap smaller than a header — done with this region.
        if (type === MSG.NIL) break
        throw new Hdf5Error(
          `object-header message (type 0x${type.toString(16)}) size ${size} overruns its chunk`,
          msgStart,
        )
      }

      if (flags & FLAG_SHARED)
        throw new Hdf5Error(
          `shared object-header message (type 0x${type.toString(16)}) — the shared-message ` +
            `table is outside the INC-A subset`,
          msgStart,
        )

      if (type === MSG.OBJECT_HEADER_CONTINUATION) {
        c.seek(bodyStart)
        const contOffset = c.offset()
        const contLength = c.length()
        if (region.v2) {
          // v2 continuation blocks start with "OCHK" + end with a 4-byte checksum.
          regions.push({
            start: contOffset + 4,
            end: contOffset + contLength - 4,
            creationOrder: region.creationOrder,
            v2: true,
          })
        } else {
          regions.push({
            start: contOffset,
            end: contOffset + contLength,
            creationOrder: false,
            v2: false,
          })
        }
      } else if (type === MSG.NIL) {
        // padding — ignore
      } else if (!KNOWN.has(type)) {
        if (flags & FLAG_MUST_UNDERSTAND)
          throw new Hdf5Error(
            `unknown object-header message type 0x${type.toString(16)} with the ` +
              `must-understand flag set — outside the INC-A subset`,
            msgStart,
          )
        // else: an optional message we may safely ignore.
      } else {
        out.push({ type, flags, bodyStart, bodySize: size })
      }

      c.seek(bodyStart + size)
      // v1 messages are 8-byte aligned WITHIN THE CHUNK — relative to region.start, NOT
      // the absolute file offset. A continuation block can begin off an 8-byte boundary
      // (real NOAA S-111 cells do: a symbol-table chunk at 0x7116); an absolute align(8)
      // then skips the next message's 2-byte header and the walk mis-parses datatype text
      // as a message type. Align against the chunk base so both cases are correct.
      if (!region.v2) {
        const rel = (c.pos - region.start) % 8
        if (rel !== 0) c.seek(c.pos + (8 - rel))
      }
    }
  }
  return out
}

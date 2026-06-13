// MapLibre glyphs.proto decoder. The schema:
//
//   message glyphs {
//     repeated fontstack stacks = 1;
//   }
//   message fontstack {
//     required string name  = 1;
//     required string range = 2;       // e.g. "0-255"
//     repeated glyph  glyphs = 3;
//   }
//   message glyph {
//     required uint32 id      = 1;
//     optional bytes  bitmap  = 2;     // (width+2*buffer) × (height+2*buffer), tiny-sdf packing
//     required uint32 width   = 3;
//     required uint32 height  = 4;
//     required sint32 left    = 5;
//     required sint32 top     = 6;
//     required uint32 advance = 7;
//   }
//
// Buffer is fixed at 3 px on each side by MapLibre convention — the
// bitmap dimensions are therefore (width+6, height+6). The encoded SDF
// uses 192 = glyph edge (tiny-sdf compatible).

import { PbfReader, PbfEofError } from './varint'

export interface PbfGlyph {
  id: number
  bitmap: Uint8Array
  width: number
  height: number
  left: number
  top: number
  advance: number
}

export interface PbfFontstack {
  name: string
  range: string
  glyphs: Map<number, PbfGlyph>
}

export function decodeGlyphsPbf(buf: Uint8Array): PbfFontstack[] {
  const r = new PbfReader(buf)
  const stacks: PbfFontstack[] = []
  try {
    while (r.pos < r.len) {
      const before = r.pos
      const { field, wire } = r.readTag()
      // A zero field is never valid; combined with a no-progress check it
      // prevents a corrupt/zero-padded tail from spinning the loop.
      if (field === 0) break
      if (field === 1 && wire === 2) stacks.push(r.readMessage(readFontstack))
      else r.skip(wire)
      if (r.pos <= before) break
    }
  } catch (e) {
    // Truncated / inconsistent PBF — return whatever decoded cleanly so
    // callers (glyph cache, inline provider) fall back gracefully instead
    // of crashing or hanging. Anything other than our bounded EOF signal
    // is a genuine bug and is re-thrown.
    if (!(e instanceof PbfEofError)) throw e
  }
  return stacks
}

function readFontstack(r: PbfReader, end: number): PbfFontstack {
  const stack: PbfFontstack = { name: '', range: '', glyphs: new Map() }
  while (r.pos < end) {
    const before = r.pos
    const { field, wire } = r.readTag()
    if (field === 0) break
    if (field === 1 && wire === 2) {
      const len = r.readVarint()
      stack.name = r.readString(len)
    } else if (field === 2 && wire === 2) {
      const len = r.readVarint()
      stack.range = r.readString(len)
    } else if (field === 3 && wire === 2) {
      const g = r.readMessage(readGlyph)
      stack.glyphs.set(g.id, g)
    } else r.skip(wire)
    if (r.pos <= before) break
  }
  return stack
}

function readGlyph(r: PbfReader, end: number): PbfGlyph {
  let id = 0, width = 0, height = 0, left = 0, top = 0, advance = 0
  let bitmap = new Uint8Array(0)
  while (r.pos < end) {
    const before = r.pos
    const { field, wire } = r.readTag()
    if (field === 0) break
    if (field === 1 && wire === 0) id = r.readVarint()
    else if (field === 2 && wire === 2) {
      const len = r.readVarint()
      // Copy out — PbfReader.readBytes returns a subarray view of the
      // source buffer, which would alias the caller's input. Defensive
      // copy so the caller can drop the input buffer.
      bitmap = new Uint8Array(r.readBytes(len))
    }
    else if (field === 3 && wire === 0) width = r.readVarint()
    else if (field === 4 && wire === 0) height = r.readVarint()
    else if (field === 5 && wire === 0) left = r.readSignedVarint()
    else if (field === 6 && wire === 0) top = r.readSignedVarint()
    else if (field === 7 && wire === 0) advance = r.readVarint()
    else r.skip(wire)
    if (r.pos <= before) break
  }
  return { id, bitmap, width, height, left, top, advance }
}

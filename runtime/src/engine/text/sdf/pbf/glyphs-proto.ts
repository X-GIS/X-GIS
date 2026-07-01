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

import { PbfReader, PbfEofError } from '@xgis/map'

const PBF_BUFFER = 3  // px of outer buffer per side (bitmap = (w+6)×(h+6))
// Sane ceiling on glyph dimensions. PBFs are baked at a 24-px reference,
// so even bold/CJK glyphs stay well under ~100 px per side; a couple of
// hundred is a generous bound. width/height are untrusted uint32 varints
// from a network glyph PBF — without a ceiling a forged glyph could carry
// an absurd (e.g. 2e8) dimension that the slot copier then has to defend
// against. Beyond the ceiling we drop the glyph so the rasteriser falls
// back to Canvas2D.
const MAX_GLYPH_DIM = 256

// Amplification ceilings on the COUNT of decoded entries. The 8 MB input cap
// (MAX_GLYPH_BYTES in glyph-pbf-cache.ts) bounds the wire size, but a body of
// minimal advance-only glyph submessages is only a few bytes each — 8 MB packs
// ~1.4M of them, and each lands in a Map (~336 MB resident). A 256-codepoint
// range legitimately holds ≤256 glyphs (1024 is a generous bound), and a glyphs
// PBF carries a small handful of fontstacks (64 is generous). Past either cap we
// stop adding (drop the excess) — fail-closed, never throw, mirroring the
// MAX_GLYPH_DIM dimension cap so a forged PBF degrades to a partial result.
const MAX_GLYPHS_PER_STACK = 1024
const MAX_FONTSTACKS = 64

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
      if (field === 1 && wire === 2) {
        // Fontstack-count cap (amplification DoS): drop any fontstack past the
        // ceiling. Stop decoding entirely — a conformant glyphs PBF never holds
        // dozens of stacks, so the tail is forged padding.
        if (stacks.length >= MAX_FONTSTACKS) break
        stacks.push(r.readMessage(readFontstack))
      }
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
      // Per-stack glyph-count cap (amplification DoS): once the ceiling is hit,
      // stop adding (drop the excess) — fail-closed like MAX_GLYPH_DIM. Skip to
      // the message end so the reader resyncs cleanly instead of misparsing the
      // forged tail. A legit 256-codepoint range never exceeds this bound.
      if (stack.glyphs.size >= MAX_GLYPHS_PER_STACK) { r.pos = end; break }
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
  // Cross-field validation of untrusted dimensions. The bitmap must be
  // exactly (width+6)×(height+6) per the buffer convention, and the
  // dimensions must stay under a sane ceiling. A glyph that violates
  // either is malformed/forged: drop its bitmap (and zero the bbox) so
  // the rasteriser falls back to Canvas2D instead of copying a bitmap
  // whose declared size does not match its contents. advance/left/top
  // are kept — a bitmap-less glyph is a valid advance-only entry.
  if (bitmap.length > 0) {
    const expected = (width + 2 * PBF_BUFFER) * (height + 2 * PBF_BUFFER)
    if (
      width > MAX_GLYPH_DIM ||
      height > MAX_GLYPH_DIM ||
      bitmap.length !== expected
    ) {
      bitmap = new Uint8Array(0)
      width = 0
      height = 0
    }
  }
  return { id, bitmap, width, height, left, top, advance }
}

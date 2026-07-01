// In-memory GlyphProvider seeded with pre-loaded PBF range data.
//
// Use case: closed-network / military / air-gapped deployments where
// the host application ships the PBF bytes inside its own bundle and
// hands them off to X-GIS at boot. Zero network calls — first-frame
// labels render with the authored typeface immediately, regardless of
// connectivity.
//
// API mirror to GlyphPbfCache so the rasterizer chain treats them
// uniformly: same `get()` shape, no `ensure()` because there's nothing
// to fetch (the data is already here).
//
// Composes naturally with HTTP-backed providers — typical chain order
// is `[Inline, Http]` so inline data shadows network requests for any
// (fontstack, range) the host has pre-bundled, while everything else
// falls through to the HTTP provider's lazy fetch path.

import { decodeGlyphsPbf, type PbfGlyph } from './glyphs-proto'
import type { GlyphProvider } from './glyph-provider'

export interface InlineGlyphSeed {
  /** Either pre-decoded glyph map, or raw PBF bytes that will be
   *  decoded once on first access. Bytes form is friendlier for hosts
   *  that just embed an ArrayBuffer from `fs.readFile` / `fetch`
   *  without unpacking the schema themselves. */
  glyphs?: Map<number, PbfGlyph>
  bytes?: Uint8Array
}

/** Either bytes-per-range OR a single PBF blob keyed by range start. */
export type InlineGlyphSource =
  | { [rangeStart: number]: Uint8Array | InlineGlyphSeed }

export class InlineGlyphProvider implements GlyphProvider {
  /** Outer key: fontstack ("Open Sans Semibold"). Inner key: range
   *  start (0, 256, 512, ...). Value: decoded glyph map for that
   *  range. Decoded lazily on first miss-and-then-hit so callers can
   *  hand us raw bytes without paying decode cost up front. */
  private readonly ranges = new Map<string, Map<number, Map<number, PbfGlyph>>>()
  /** Undecoded raw bytes, parallel to `ranges`. Populated on
   *  construction; drained into `ranges` lazily. */
  private readonly rawBytes = new Map<string, Map<number, Uint8Array>>()

  constructor(seed: { [fontstack: string]: InlineGlyphSource }) {
    for (const [fontstack, perRange] of Object.entries(seed)) {
      const decoded = new Map<number, Map<number, PbfGlyph>>()
      const rawForStack = new Map<number, Uint8Array>()
      for (const [rangeKey, value] of Object.entries(perRange)) {
        const rangeStart = Number(rangeKey)
        if (value instanceof Uint8Array) {
          rawForStack.set(rangeStart, value)
        } else if (value.bytes) {
          rawForStack.set(rangeStart, value.bytes)
        } else if (value.glyphs) {
          decoded.set(rangeStart, value.glyphs)
        }
      }
      this.ranges.set(fontstack, decoded)
      this.rawBytes.set(fontstack, rawForStack)
    }
  }

  get(fontstack: string, codepoint: number): PbfGlyph | undefined {
    const start = Math.floor(codepoint / 256) * 256
    const stackDecoded = this.ranges.get(fontstack)
    let glyphs = stackDecoded?.get(start)
    if (!glyphs) {
      // Try lazy decode from raw bytes.
      const rawForStack = this.rawBytes.get(fontstack)
      const raw = rawForStack?.get(start)
      if (!raw) return undefined
      const stacks = decodeGlyphsPbf(raw)
      const match = stacks.find(s => s.name === fontstack) ?? stacks[0]
      if (!match) return undefined
      glyphs = match.glyphs
      if (stackDecoded) stackDecoded.set(start, glyphs)
      else this.ranges.set(fontstack, new Map([[start, glyphs]]))
      // Free the bytes — the decoded map is the source of truth now.
      rawForStack!.delete(start)
    }
    return glyphs.get(codepoint)
  }

  // No `ensure()` — inline data has nothing to fetch.
}

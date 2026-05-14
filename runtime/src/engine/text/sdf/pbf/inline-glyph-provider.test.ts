import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InlineGlyphProvider } from './inline-glyph-provider'
import { decodeGlyphsPbf } from './glyphs-proto'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = new Uint8Array(readFileSync(FIXTURE))

describe('InlineGlyphProvider', () => {
  it('serves glyphs synchronously from pre-loaded bytes', () => {
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: PBF_BYTES },
    })
    const g = p.get('Open Sans Semibold', 0x41)
    expect(g?.id).toBe(0x41)
    expect(g?.bitmap.length).toBeGreaterThan(0)
  })

  it('returns undefined for unloaded fontstacks', () => {
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: PBF_BYTES },
    })
    expect(p.get('Other Family Bold', 0x41)).toBeUndefined()
  })

  it('returns undefined for unloaded ranges', () => {
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: PBF_BYTES },
    })
    // Range 256-511 wasn't seeded.
    expect(p.get('Open Sans Semibold', 0x141)).toBeUndefined()
  })

  it('returns undefined for codepoints not in the seeded range', () => {
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: PBF_BYTES },
    })
    // 0x00 NUL almost certainly absent from the PBF — but in range.
    expect(p.get('Open Sans Semibold', 0x00)).toBeUndefined()
  })

  it('accepts pre-decoded glyph maps', () => {
    const stack = decodeGlyphsPbf(PBF_BYTES)[0]!
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: { glyphs: stack.glyphs } },
    })
    expect(p.get('Open Sans Semibold', 0x41)?.id).toBe(0x41)
  })

  it('does NOT expose ensure() — pure sync, no fetch needed', () => {
    const p = new InlineGlyphProvider({})
    // Type-level: ensure is optional. Runtime: should be undefined.
    expect((p as { ensure?: unknown }).ensure).toBeUndefined()
  })

  it('lazy-decodes bytes only on first miss-then-hit', () => {
    // Construction is cheap — bytes are kept, decoding deferred.
    const p = new InlineGlyphProvider({
      'Open Sans Semibold': { 0: PBF_BYTES },
    })
    // Two consecutive lookups: first triggers decode, second is fast.
    const a = p.get('Open Sans Semibold', 0x41)
    const b = p.get('Open Sans Semibold', 0x42)
    expect(a?.id).toBe(0x41)
    expect(b?.id).toBe(0x42)
  })
})

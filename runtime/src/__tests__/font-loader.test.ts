// Font loader smoke. Builds a tiny TTF in-memory via opentype.js
// (no fixture file needed) and exercises the loader + ShapeRegistry
// integration end-to-end.

import { describe, expect, it, beforeEach } from 'vitest'
import opentype from 'opentype.js'
import { extractGlyph, glyphShapeName, clearFontCache } from '../engine/font-loader'
import type { FontData } from '../engine/font-loader'

// Construct a minimal in-memory font with two glyphs:
//   - .notdef (required at index 0)
//   - 'A' (codepoint 65) — single triangle path
// opentype.js can serialise this to a TTF arrayBuffer that the
// loader can parse — but easier still, we just hand the loader the
// already-parsed Font object via a synthetic FontData.
function makeTinyFont(): FontData {
  const notdef = new opentype.Glyph({
    name: '.notdef',
    advanceWidth: 500,
    path: new opentype.Path(),
  })
  const aPath = new opentype.Path()
  // Triangle from (0,0) to (500,500) to (250,1000)
  aPath.moveTo(0, 0)
  aPath.lineTo(500, 500)
  aPath.lineTo(250, 1000)
  aPath.close()
  const aGlyph = new opentype.Glyph({
    name: 'A',
    unicode: 65,
    advanceWidth: 600,
    path: aPath,
  })
  const font = new opentype.Font({
    familyName: 'Tiny',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [notdef, aGlyph],
  })
  return {
    key: 'Tiny Regular',
    font,
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
  }
}

describe('font-loader', () => {
  beforeEach(() => clearFontCache())

  it('extracts a glyph with path + advance width', () => {
    const font = makeTinyFont()
    const glyph = extractGlyph(font, 65) // 'A'
    expect(glyph).not.toBeNull()
    expect(glyph!.advanceWidth).toBe(600)
    expect(glyph!.pathData.length).toBeGreaterThan(0)
    // Path d-string should start with M (moveTo) per SVG convention.
    expect(glyph!.pathData[0]).toBe('M')
  })

  it('returns null for unmapped codepoints', () => {
    const font = makeTinyFont()
    // Codepoint 0x4E2D ('中') isn't in our tiny font.
    const glyph = extractGlyph(font, 0x4E2D)
    expect(glyph).toBeNull()
  })

  it('produces stable shape names', () => {
    expect(glyphShapeName('Open Sans Regular', 65)).toBe('glyph:Open Sans Regular:65')
    expect(glyphShapeName('Tiny Regular', 32)).toBe('glyph:Tiny Regular:32')
  })

  it('captures bbox for non-empty glyphs', () => {
    const font = makeTinyFont()
    const glyph = extractGlyph(font, 65)
    expect(glyph!.bbox).not.toBeNull()
    expect(glyph!.bbox!.xMin).toBeLessThan(glyph!.bbox!.xMax)
    expect(glyph!.bbox!.yMin).toBeLessThan(glyph!.bbox!.yMax)
  })
})

// Also exercise the ShapeRegistry → glyph integration without a real
// GPU device. addGlyph parses the path and computes segments, all
// CPU-side; uploadToGPU is the only path that needs the device.
import { ShapeRegistry } from '../engine/sdf-shape'

describe('ShapeRegistry.addGlyph', () => {
  it('registers a glyph as a shape and returns a non-zero id', () => {
    // ShapeRegistry's constructor calls device.createBuffer lazily
    // via uploadToGPU; addShape itself is pure CPU. Pass a minimal
    // mock device that satisfies the type but isn't called here.
    const fakeDevice = {} as unknown as GPUDevice
    const reg = new ShapeRegistry(fakeDevice)
    const font = makeTinyFont()
    const glyph = extractGlyph(font, 65)
    const id = reg.addGlyph(font.key, 65, glyph!.pathData, font.unitsPerEm)
    expect(id).toBeGreaterThan(0)
    // Re-registration is idempotent: same name → same id.
    const id2 = reg.addGlyph(font.key, 65, glyph!.pathData, font.unitsPerEm)
    expect(id2).toBe(id)
  })

  it('returns 0 for empty path (whitespace glyph)', () => {
    const fakeDevice = {} as unknown as GPUDevice
    const reg = new ShapeRegistry(fakeDevice)
    const id = reg.addGlyph('Tiny Regular', 32, '', 1000)
    expect(id).toBe(0)
  })
})

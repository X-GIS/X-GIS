// Unit tests for CSS rgb / rgba / hsl / hsla colour parsing in
// resolveColor. Hex, palette names, and named colours are covered
// elsewhere — this suite pins the CSS-function syntax.

import { describe, expect, it } from 'vitest'
import { resolveColor } from '../tokens/colors'

describe('resolveColor — CSS rgb()', () => {
  it('parses 3-arg rgb()', () => {
    expect(resolveColor('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(resolveColor('rgb(0, 128, 0)')).toBe('#008000')
  })

  it('parses 4-arg rgba() with 0..1 alpha', () => {
    expect(resolveColor('rgba(255, 0, 0, 1)')).toBe('#ff0000')
    expect(resolveColor('rgba(0, 0, 0, 0.5)')).toBe('#00000080')
  })

  it('parses CSS-modern slash alpha', () => {
    expect(resolveColor('rgb(255 0 0 / 0.5)')).toBe('#ff000080')
  })

  it('accepts percent channels', () => {
    expect(resolveColor('rgb(100%, 0%, 0%)')).toBe('#ff0000')
    expect(resolveColor('rgb(50%, 50%, 50%)')).toBe('#808080')
  })

  it('clamps out-of-range values', () => {
    expect(resolveColor('rgb(300, -10, 128)')).toBe('#ff0080')
  })

  it('returns null for malformed rgb()', () => {
    expect(resolveColor('rgb(255)')).toBeNull()
    expect(resolveColor('rgb(a, b, c)')).toBeNull()
  })
})

describe('resolveColor — CSS hsl()', () => {
  it('parses 3-arg hsl()', () => {
    // hsl(0, 100%, 50%) = pure red
    expect(resolveColor('hsl(0, 100%, 50%)')).toBe('#ff0000')
    // hsl(120, 100%, 50%) = pure green
    expect(resolveColor('hsl(120, 100%, 50%)')).toBe('#00ff00')
    // hsl(240, 100%, 50%) = pure blue
    expect(resolveColor('hsl(240, 100%, 50%)')).toBe('#0000ff')
  })

  it('parses 4-arg hsla() with alpha', () => {
    // half-transparent red
    expect(resolveColor('hsla(0, 100%, 50%, 0.5)')).toBe('#ff000080')
  })

  it('accepts deg/turn units on hue', () => {
    expect(resolveColor('hsl(120deg, 100%, 50%)')).toBe('#00ff00')
    // 0.5turn = 180° (cyan)
    expect(resolveColor('hsl(0.5turn, 100%, 50%)')).toBe('#00ffff')
  })

  it('produces gray for s=0', () => {
    // l=50% → mid-gray regardless of hue
    expect(resolveColor('hsl(0, 0%, 50%)')).toBe('#808080')
  })

  it('returns null for malformed hsl()', () => {
    expect(resolveColor('hsl(blue, 50%, 50%)')).toBeNull()
  })
})

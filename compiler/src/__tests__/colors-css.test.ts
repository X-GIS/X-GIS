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

describe('resolveColor — CSS hwb()', () => {
  it('hwb(0, 0%, 0%) = pure red (no white, no black)', () => {
    expect(resolveColor('hwb(0, 0%, 0%)')).toBe('#ff0000')
  })

  it('hwb(120, 0%, 0%) = pure green', () => {
    expect(resolveColor('hwb(120, 0%, 0%)')).toBe('#00ff00')
  })

  it('hwb(240, 0%, 0%) = pure blue', () => {
    expect(resolveColor('hwb(240, 0%, 0%)')).toBe('#0000ff')
  })

  it('hwb with 50% whiteness → light tint', () => {
    // hue=0 (red), whiteness=50%, blackness=0%
    // → (1*1+0.5)*255 on R, 0.5*255 on G/B = (255, 128, 128) ≈ pink
    expect(resolveColor('hwb(0, 50%, 0%)')).toBe('#ff8080')
  })

  it('hwb with 50% blackness → dark shade', () => {
    // hue=0, whiteness=0%, blackness=50%
    // → R = 1*0.5*255 = 128, G/B = 0
    expect(resolveColor('hwb(0, 0%, 50%)')).toBe('#800000')
  })

  it('hwb whiteness + blackness ≥ 100% normalises to grey', () => {
    // 50/50 split → mid grey
    expect(resolveColor('hwb(0, 50%, 50%)')).toBe('#808080')
    // 75% white, 25% black → 75% grey
    expect(resolveColor('hwb(0, 75%, 25%)')).toBe('#bfbfbf')
  })

  it('hwb modern slash alpha', () => {
    expect(resolveColor('hwb(0 0% 0% / 0.5)')).toBe('#ff000080')
  })

  it('hwb accepts deg unit on hue', () => {
    expect(resolveColor('hwb(120deg, 0%, 0%)')).toBe('#00ff00')
  })

  it('returns null for malformed hwb()', () => {
    expect(resolveColor('hwb(0)')).toBeNull()
    expect(resolveColor('hwb(a, b, c)')).toBeNull()
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

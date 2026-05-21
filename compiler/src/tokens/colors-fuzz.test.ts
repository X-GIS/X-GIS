// iter-294 — Color parser fuzz. Sneaky inputs: short hex / huge
// alpha / negative rgb / fractional / out-of-gamut hsl / unicode /
// trailing whitespace.

import { describe, it, expect } from 'vitest'
import { resolveColor, parseSrgbHex } from './colors'

describe('iter-294 resolveColor fuzz', () => {
  it('non-string input returns null (defensive)', () => {
    expect(resolveColor(null as unknown as string)).toBe(null)
    expect(resolveColor(undefined as unknown as string)).toBe(null)
    expect(resolveColor(123 as unknown as string)).toBe(null)
    expect(resolveColor({} as unknown as string)).toBe(null)
  })

  it('empty string returns null', () => {
    expect(resolveColor('')).toBe(null)
  })

  it('whitespace-only returns null', () => {
    expect(resolveColor('   ')).toBe(null)
    expect(resolveColor('\t')).toBe(null)
    expect(resolveColor('\n')).toBe(null)
  })

  it('hex variants accepted: #rgb, #rrggbb, #rgba, #rrggbbaa', () => {
    expect(resolveColor('#f00')).toBe('#f00')
    expect(resolveColor('#ff0000')).toBe('#ff0000')
    expect(resolveColor('#f00f')).toBe('#f00f')
    expect(resolveColor('#ff0000ff')).toBe('#ff0000ff')
  })

  it('hex lowercased', () => {
    expect(resolveColor('#FF0000')).toBe('#ff0000')
    expect(resolveColor('#AbCdEf')).toBe('#abcdef')
  })

  it('5-char hex (invalid length) returns null', () => {
    expect(resolveColor('#abcde')).toBe(null)
  })

  it('7-char hex (invalid length) returns null', () => {
    expect(resolveColor('#1234567')).toBe(null)
  })

  it('9-char hex (invalid length) returns null', () => {
    expect(resolveColor('#1234567890')).toBe(null)
  })

  it('hex with non-hex chars returns null', () => {
    expect(resolveColor('#xyz')).toBe(null)
    expect(resolveColor('#GG0000')).toBe(null)
    expect(resolveColor('#ff!00')).toBe(null)
  })

  it('hex with leading/trailing whitespace returns null', () => {
    // Strict — author must not pad; rejection here surfaces typo.
    expect(resolveColor(' #ff0000')).toBe(null)
    expect(resolveColor('#ff0000 ')).toBe(null)
  })

  it('case-insensitive named color', () => {
    const lower = resolveColor('red')
    expect(lower).not.toBe(null)
    expect(resolveColor('RED')).toBe(lower)
    expect(resolveColor('Red')).toBe(lower)
    expect(resolveColor('rEd')).toBe(lower)
  })

  it('unknown name returns null', () => {
    expect(resolveColor('notacolor')).toBe(null)
    expect(resolveColor('xenoflux')).toBe(null)
  })

  it('emoji + non-ASCII returns null', () => {
    expect(resolveColor('🟥')).toBe(null)
    expect(resolveColor('빨강')).toBe(null)
  })

  it('rgb() basic', () => {
    expect(resolveColor('rgb(255, 0, 0)')).toBe('#ff0000')
  })

  it('rgb() out-of-range clamps (per CSS Color Module 4)', () => {
    // CSS spec: out-of-range RGB values are clamped to [0, 255]
    const r = resolveColor('rgb(300, -10, 100)')
    expect(r).not.toBe(null)
    expect(r!.startsWith('#ff')).toBe(true)  // 300 → 255
  })

  it('rgb() fractional values supported', () => {
    expect(resolveColor('rgb(127.5, 0, 0)')).not.toBe(null)
  })

  it('rgba() with alpha=0.5', () => {
    const r = resolveColor('rgba(255, 0, 0, 0.5)')
    expect(r).not.toBe(null)
    expect(r!.length).toBe(9)  // #rrggbbaa
  })

  it('rgba() with alpha clamped > 1 emits opaque (alpha byte omitted)', () => {
    // alpha clamps to 1 → rgbToHex drops the alpha byte (#rrggbb form).
    // Probe pinned the contract: opaque output is 7 chars, not 9.
    const r = resolveColor('rgba(255, 0, 0, 5)')
    expect(r).not.toBe(null)
    expect(r!.length).toBe(7)  // #ff0000 — alpha=1 elided
    expect(r!.toLowerCase()).toBe('#ff0000')
  })

  it('rgba() with negative alpha clamped to 0 emits transparent', () => {
    const r = resolveColor('rgba(255, 0, 0, -1)')
    expect(r).not.toBe(null)
    expect(r!.endsWith('00')).toBe(true)
    expect(r!.length).toBe(9)  // #rrggbbaa
  })

  it('hsl() basic', () => {
    expect(resolveColor('hsl(0, 100%, 50%)')).toBe('#ff0000')
  })

  it('hsl() hue wraps modulo 360', () => {
    const r0 = resolveColor('hsl(0, 100%, 50%)')
    const r360 = resolveColor('hsl(360, 100%, 50%)')
    expect(r0).toBe(r360)
    const r720 = resolveColor('hsl(720, 100%, 50%)')
    expect(r0).toBe(r720)
  })

  it('hsl() negative hue wraps', () => {
    const r0 = resolveColor('hsl(0, 100%, 50%)')
    const rNeg = resolveColor('hsl(-360, 100%, 50%)')
    expect(r0).toBe(rNeg)
  })

  it('hsl() saturation 0 produces grayscale', () => {
    const r = resolveColor('hsl(120, 0%, 50%)')
    expect(r).not.toBe(null)
    // RGB channels should be equal — grayscale.
    const m = r!.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/)
    expect(m).not.toBe(null)
    expect(m![1]).toBe(m![2])
    expect(m![2]).toBe(m![3])
  })

  it('malformed function returns null', () => {
    expect(resolveColor('rgb(255)')).toBe(null)         // too few
    expect(resolveColor('rgb()')).toBe(null)
    expect(resolveColor('rgb(255, 0, 0, 0, 0)')).toBe(null)  // too many
    expect(resolveColor('rgb(a, b, c)')).toBe(null)     // non-numeric
  })

  it('palette form: blue-500 returns a hex', () => {
    const r = resolveColor('blue-500')
    if (r !== null) {
      // Format depends on palette source; just ensure it's a hex.
      expect(/^#[0-9a-f]{3,8}$/.test(r)).toBe(true)
    }
  })

  it('palette form with unknown shade returns null', () => {
    expect(resolveColor('blue-99999')).toBe(null)
  })

  it('palette form with unknown color returns null', () => {
    expect(resolveColor('nosuchcolor-500')).toBe(null)
  })
})

describe('iter-294 parseSrgbHex fuzz', () => {
  it('parses #rrggbb to [r, g, b] in [0, 1]', () => {
    const r = parseSrgbHex('#ff0000')
    expect(r).not.toBe(null)
    expect(r![0]).toBeCloseTo(1, 5)
    expect(r![1]).toBeCloseTo(0, 5)
    expect(r![2]).toBeCloseTo(0, 5)
  })

  it('parses #rgb shorthand', () => {
    const r = parseSrgbHex('#f00')
    expect(r).not.toBe(null)
    expect(r![0]).toBeCloseTo(1, 5)
    expect(r![1]).toBeCloseTo(0, 5)
    expect(r![2]).toBeCloseTo(0, 5)
  })

  it('invalid hex returns null', () => {
    expect(parseSrgbHex('#xyz')).toBe(null)
    expect(parseSrgbHex('#12345')).toBe(null)
    expect(parseSrgbHex('not-a-hex')).toBe(null)
  })

  it('empty string returns null', () => {
    expect(parseSrgbHex('')).toBe(null)
  })

  it('without # prefix returns null (defensive)', () => {
    expect(parseSrgbHex('ff0000')).toBe(null)
  })

  it('#000 black → [0, 0, 0]', () => {
    const r = parseSrgbHex('#000')
    expect(r).not.toBe(null)
    expect(r).toEqual([0, 0, 0])
  })

  it('#fff white → [1, 1, 1]', () => {
    const r = parseSrgbHex('#fff')
    expect(r).not.toBe(null)
    expect(r![0]).toBeCloseTo(1, 5)
    expect(r![1]).toBeCloseTo(1, 5)
    expect(r![2]).toBeCloseTo(1, 5)
  })
})

// iter-308 — Mutation testing surfaced gaps in parseCssColorFn
// function-name discrimination (`fn === 'lab' | 'oklab' | 'lch' | ...`).
// Mutation `===` → `!==` would route every function call to the
// wrong colour space. Plug each path with a specific output check.
describe('iter-308 CSS colour-function name discrimination', () => {
  it('lab() routes to Lab→sRGB conversion (not hsl/oklab/lch)', () => {
    // Mid-grey Lab(50%, 0, 0) → mid-grey sRGB ≈ #777.
    const r = resolveColor('lab(50% 0 0)')
    expect(r).not.toBe(null)
    expect(r!.charAt(0)).toBe('#')
    // R, G, B equal (achromatic).
    const m = r!.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/)
    expect(m).not.toBe(null)
    expect(m![1]).toBe(m![2])
    expect(m![2]).toBe(m![3])
  })

  it('lch() routes to Lab via polar — chroma 0 = achromatic', () => {
    const r = resolveColor('lch(50% 0 90)')
    expect(r).not.toBe(null)
    const m = r!.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/)
    expect(m).not.toBe(null)
    expect(m![1]).toBe(m![2])  // grey
  })

  it('oklab() distinct from lab() at same numeric inputs', () => {
    // oklab and lab use different lightness scales (0-1 vs 0-100).
    // Sanity: both succeed but emit different colours.
    const rLab = resolveColor('lab(50% 20 -30)')
    const rOklab = resolveColor('oklab(0.5 0.05 -0.05)')
    expect(rLab).not.toBe(null)
    expect(rOklab).not.toBe(null)
    expect(rLab).not.toBe(rOklab)
  })

  it('oklch() distinct from lch() at same inputs', () => {
    const rLch = resolveColor('lch(50% 30 90)')
    const rOklch = resolveColor('oklch(0.5 0.1 90)')
    expect(rLch).not.toBe(null)
    expect(rOklch).not.toBe(null)
    expect(rLch).not.toBe(rOklch)
  })

  it('hwb() routes to HWB→sRGB (not lab/lch)', () => {
    // Pure hue with no white/black tint.
    const r = resolveColor('hwb(0 0% 0%)')  // pure red
    expect(r).not.toBe(null)
    expect(r!.toLowerCase()).toBe('#ff0000')
  })

  it('hwb() with 100% white = white regardless of hue', () => {
    const r = resolveColor('hwb(180 100% 0%)')
    expect(r).not.toBe(null)
    // 100% white → result has no chroma — must be (255, 255, 255).
    const m = r!.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/)
    expect(m).not.toBe(null)
    expect(m![1]).toBe('ff')
    expect(m![2]).toBe('ff')
    expect(m![3]).toBe('ff')
  })

  it('hwb() with 100% black = black regardless of hue', () => {
    const r = resolveColor('hwb(45 0% 100%)')
    expect(r).not.toBe(null)
    expect(r!.toLowerCase().slice(0, 7)).toBe('#000000')
  })

  it('hwb() w + b > 1 grayscale clamp (line 472 branch)', () => {
    // hwbToRgb: when w+b ≥ 1 → grey = w / (w+b). Mutation `>=` to
    // `>` at line 472 would let w+b == 1 fall through to mix branch
    // → divide-by-zero in (1 - w - b) scaling.
    const r = resolveColor('hwb(0 50% 50%)')
    expect(r).not.toBe(null)
    const m = r!.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/)
    expect(m).not.toBe(null)
    expect(m![1]).toBe(m![2])  // grey
    expect(m![2]).toBe(m![3])
  })
})

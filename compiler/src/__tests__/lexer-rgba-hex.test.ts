// #2543 — the lexer was the only component in the pipeline that rejected
// the CSS Color Module 4 four-digit `#rgba` shorthand. The Mapbox
// converter validates and emits it (`convert/colors.ts:69`,
// `/^#([0-9a-fA-F]{3,4}|…)$/`), `tokens/colors.ts:resolveColorToRgba` and
// `ir/render-node-helpers.ts:hexToRgba` both carry a `length === 5`
// branch, and so does the runtime — but `readColor` accepted only
// lengths 4 / 7 / 9, so a converted style with `"fill-color": "#f00a"`
// converted with zero warnings and then threw on tokenize, killing the
// whole import.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { TokenType } from '../lexer/tokens'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { resolveColorToRgba } from '../tokens/colors'

function lex(source: string) {
  return new Lexer(source)
    .tokenize()
    .filter((t) => t.type !== TokenType.Newline && t.type !== TokenType.EOF)
}

describe('lexer #rgba (CSS Color Module 4 four-digit hex)', () => {
  it('lexes all four hex shapes as a single Color token each', () => {
    const tokens = lex('#f00 #f00a #ff0000 #ff0000aa')
    expect(tokens.map((t) => t.value)).toEqual(['#f00', '#f00a', '#ff0000', '#ff0000aa'])
    expect(tokens.every((t) => t.type === TokenType.Color)).toBe(true)
  })

  it('still rejects a malformed 5-digit body', () => {
    expect(() => lex('#12345')).toThrow(/Invalid color literal/)
    expect(() => lex('#ff')).toThrow(/Invalid color literal/)
  })

  it('carries the alpha channel from the lexed token to rgba', () => {
    const [token] = lex('#f00a')
    expect(token!.value).toBe('#f00a')
    const [r, g, b, a] = resolveColorToRgba(token!.value)
    expect([r, g, b]).toEqual([1, 0, 0])
    expect(a).toBeCloseTo(0xaa / 255, 5)
  })

  it('converter → lexer round-trips a #rgba paint with no warning', () => {
    const code = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [{ id: 'L', type: 'fill', source: 's', paint: { 'fill-color': '#f00a' } }],
    } as never)
    expect(code).toContain('#f00a')
    expect(code).not.toMatch(/looks like a hex literal/)
    expect(() => new Lexer(code).tokenize()).not.toThrow()
  })
})

// TextStage covers two concerns testable without WebGPU:
//   1. text-transform application
//   2. Empty-text skip semantics
//
// The WebGPU surface (atlas GPU + renderer) is exercised in the
// e2e in 1c-8c. This test pokes the host directly via TextStage's
// public `host` to verify the wiring is correct.

import { describe, it, expect } from 'vitest'
import { applyTextTransform } from './text-stage-helpers'
import { composeFontKey } from './text-stage'
import { FONT_KEY_SENTINEL } from './sdf/glyph-rasterizer'
import type { LabelDef } from '@xgis/compiler'

const baseLabel: LabelDef = {
  text: { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: 'x' } as never } },
  size: 12,
}

describe('text-transform helper', () => {
  it('uppercase', () => {
    expect(applyTextTransform('Hello', 'uppercase')).toBe('HELLO')
  })
  it('lowercase', () => {
    expect(applyTextTransform('Hello', 'lowercase')).toBe('hello')
  })
  it('none / undefined → passthrough', () => {
    expect(applyTextTransform('Hello', 'none')).toBe('Hello')
    expect(applyTextTransform('Hello', undefined)).toBe('Hello')
  })
  it('CJK passes through (no case mapping)', () => {
    expect(applyTextTransform('서울', 'uppercase')).toBe('서울')
  })
})

describe('composeFontKey', () => {
  // The runtime-side correlate of the converter's text-font
  // splitting. If this regresses, every Mapbox-imported label
  // either loses its Bold / Italic styling (because ctx.font can't
  // parse "Noto-Sans-Bold" as a family name) or renders Hangul / Han
  // as .notdef boxes (because no CJK fallback family is in the
  // chain). Both symptoms surfaced as the "country labels invisible
  // + text-font ignored" user report.
  const DEFAULT = '"Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic","Microsoft YaHei","Noto Sans CJK JP","Hiragino Sans","Yu Gothic",sans-serif'

  it('plain family-only def: returns family + appended CJK fallback chain', () => {
    const key = composeFontKey({ ...baseLabel, font: ['Noto Sans'] }, DEFAULT)
    expect(key.startsWith(FONT_KEY_SENTINEL)).toBe(false)
    expect(key).toContain('"Noto Sans"')
    expect(key).toContain('Noto Sans CJK KR')
    expect(key).toContain('sans-serif')
  })

  it('def with fontWeight=700: sentinel-encodes style + weight + family', () => {
    const key = composeFontKey(
      { ...baseLabel, font: ['Noto Sans'], fontWeight: 700 },
      DEFAULT,
    )
    expect(key.startsWith(FONT_KEY_SENTINEL)).toBe(true)
    // Parts after the leading sentinel: [style, weight, family-list]
    const parts = key.split(FONT_KEY_SENTINEL)
    expect(parts[1]).toBe('normal')
    expect(parts[2]).toBe('700')
    expect(parts[3]).toContain('"Noto Sans"')
    expect(parts[3]).toContain('Noto Sans CJK KR')
  })

  it('def with fontStyle=italic: sentinel-encodes italic style', () => {
    const key = composeFontKey(
      { ...baseLabel, font: ['Noto Sans'], fontStyle: 'italic' },
      DEFAULT,
    )
    const parts = key.split(FONT_KEY_SENTINEL)
    expect(parts[1]).toBe('italic')
    expect(parts[2]).toBe('400')  // weight default
  })

  it('no font, no weight, no style: returns defaultFamily verbatim', () => {
    const key = composeFontKey(baseLabel, DEFAULT)
    expect(key).toBe(DEFAULT)
  })
})

// Unit tests for CSS named-colour resolution in resolveColor.
// The spec target is CSS Color Module Level 4's 148-entry table
// (147 X11 colours + `rebeccapurple` + `transparent`). Tailwind
// palette names ("red-500") are exercised in the broader interpreter
// tests; this suite focuses on the bare-identifier path.

import { describe, expect, it } from 'vitest'
import { resolveColor } from '../tokens/colors'

describe('resolveColor — CSS named colours', () => {
  it('resolves greyscale spectrum (white / silver / gray / black)', () => {
    expect(resolveColor('white')).toBe('#ffffff')
    expect(resolveColor('silver')).toBe('#c0c0c0')
    expect(resolveColor('gray')).toBe('#808080')
    expect(resolveColor('black')).toBe('#000000')
  })

  it('grey / gray spellings both map to #808080', () => {
    expect(resolveColor('grey')).toBe('#808080')
    expect(resolveColor('gray')).toBe('#808080')
    expect(resolveColor('darkgrey')).toBe('#a9a9a9')
    expect(resolveColor('darkgray')).toBe('#a9a9a9')
    expect(resolveColor('slategrey')).toBe('#708090')
    expect(resolveColor('slategray')).toBe('#708090')
  })

  it('resolves bare primary colours per CSS spec (NOT Tailwind palette)', () => {
    // These names overlap with the Tailwind PALETTE keys ('red',
    // 'green', etc.) — the resolver must distinguish bare identifier
    // (CSS named colour) from hyphenated form (Tailwind shade).
    expect(resolveColor('red')).toBe('#ff0000')      // CSS
    expect(resolveColor('green')).toBe('#008000')    // CSS, NOT Tailwind's #22c55e
    expect(resolveColor('blue')).toBe('#0000ff')     // CSS, NOT Tailwind's #3b82f6
    expect(resolveColor('yellow')).toBe('#ffff00')
    expect(resolveColor('cyan')).toBe('#00ffff')
    expect(resolveColor('magenta')).toBe('#ff00ff')
  })

  it('Tailwind palette still works (no regression from named-color addition)', () => {
    expect(resolveColor('red-500')).toBe('#ef4444')
    expect(resolveColor('blue-500')).toBe('#3b82f6')
    expect(resolveColor('slate-300')).toBe('#cbd5e1')
  })

  it('resolves common X11 colours that were missing before', () => {
    expect(resolveColor('cornflowerblue')).toBe('#6495ed')
    expect(resolveColor('tomato')).toBe('#ff6347')
    expect(resolveColor('hotpink')).toBe('#ff69b4')
    expect(resolveColor('darkolivegreen')).toBe('#556b2f')
    expect(resolveColor('lightseagreen')).toBe('#20b2aa')
  })

  it('resolves CSS4-only additions (rebeccapurple)', () => {
    expect(resolveColor('rebeccapurple')).toBe('#663399')
  })

  it('case-insensitive lookup (CSS named-colour spec)', () => {
    expect(resolveColor('Red')).toBe('#ff0000')
    expect(resolveColor('CornflowerBlue')).toBe('#6495ed')
    expect(resolveColor('REBECCAPURPLE')).toBe('#663399')
  })

  it('aqua === cyan (both #00ffff per spec)', () => {
    expect(resolveColor('aqua')).toBe(resolveColor('cyan'))
    expect(resolveColor('aqua')).toBe('#00ffff')
  })

  it('fuchsia === magenta (both #ff00ff per spec)', () => {
    expect(resolveColor('fuchsia')).toBe(resolveColor('magenta'))
    expect(resolveColor('fuchsia')).toBe('#ff00ff')
  })

  it('transparent retains its #00000000 hex form', () => {
    expect(resolveColor('transparent')).toBe('#00000000')
  })

  it('unknown names return null (not silently mapped)', () => {
    expect(resolveColor('definitelynotacolour')).toBeNull()
    expect(resolveColor('reddish')).toBeNull()
    expect(resolveColor('purplish')).toBeNull()
  })

  it('full set: 148 named colours all reachable (smoke check)', () => {
    // Representative sample across the spectrum — one per region —
    // catches typos in the bulk insertion that would otherwise only
    // surface when a user happens to type that specific name.
    const samples: [string, string][] = [
      ['aliceblue',         '#f0f8ff'],
      ['antiquewhite',      '#faebd7'],
      ['aquamarine',        '#7fffd4'],
      ['azure',             '#f0ffff'],
      ['beige',             '#f5f5dc'],
      ['burlywood',         '#deb887'],
      ['chartreuse',        '#7fff00'],
      ['crimson',           '#dc143c'],
      ['darkblue',          '#00008b'],
      ['deeppink',          '#ff1493'],
      ['dodgerblue',        '#1e90ff'],
      ['firebrick',         '#b22222'],
      ['gold',              '#ffd700'],
      ['indigo',            '#4b0082'],
      ['khaki',             '#f0e68c'],
      ['lawngreen',         '#7cfc00'],
      ['mediumseagreen',    '#3cb371'],
      ['midnightblue',      '#191970'],
      ['navajowhite',       '#ffdead'],
      ['navy',              '#000080'],
      ['olive',             '#808000'],
      ['palegoldenrod',     '#eee8aa'],
      ['papayawhip',        '#ffefd5'],
      ['peachpuff',         '#ffdab9'],
      ['plum',              '#dda0dd'],
      ['rosybrown',         '#bc8f8f'],
      ['saddlebrown',       '#8b4513'],
      ['seashell',          '#fff5ee'],
      ['springgreen',       '#00ff7f'],
      ['steelblue',         '#4682b4'],
      ['teal',              '#008080'],
      ['thistle',           '#d8bfd8'],
      ['turquoise',         '#40e0d0'],
      ['violet',            '#ee82ee'],
      ['wheat',             '#f5deb3'],
      ['yellowgreen',       '#9acd32'],
    ]
    for (const [name, expected] of samples) {
      expect(resolveColor(name)).toBe(expected)
    }
  })
})

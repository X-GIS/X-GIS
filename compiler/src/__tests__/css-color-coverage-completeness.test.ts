// Iter 547 — regression gate for CSS Color Module 4 named-color
// coverage. Iter 546 audit confirmed X-GIS' `resolveColor` resolves
// all 147 canonical CSS Color Module 3 names + `rebeccapurple` (CSS
// 4) + `transparent` = 149 entries total, byte-identical to ThreeJS'
// Color.NAMES table. Plus full CSS color-function parsing (rgb /
// rgba / hsl / hsla in both legacy comma + modern space/slash syntax,
// including percent channels).
//
// User asked iter 546 whether X-GIS supports CSS named colors; the
// answer is YES, complete. This file pins coverage so a future
// table edit can't silently drop a name.

import { describe, it, expect } from 'vitest'
import { resolveColor } from '../tokens/colors'

const CSS_COLOR_MODULE_4_NAMES = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'transparent',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]

describe('CSS Color Module 4 — named-color completeness (iter 547)', () => {
  it('exactly 149 canonical names (147 standard + rebeccapurple + transparent)', () => {
    expect(CSS_COLOR_MODULE_4_NAMES.length).toBe(149)
  })

  for (const name of CSS_COLOR_MODULE_4_NAMES) {
    it(`"${name}" resolves to hex`, () => {
      const result = resolveColor(name)
      expect(result, `${name} should resolve to a hex color`).not.toBeNull()
      expect(result).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    })
  }

  it('case-insensitive: "RED" / "Red" / "red" all resolve to #ff0000', () => {
    expect(resolveColor('red')).toBe('#ff0000')
    expect(resolveColor('RED')).toBe('#ff0000')
    expect(resolveColor('Red')).toBe('#ff0000')
  })

  it('aliases resolve to the same hex (CSS spec parity)', () => {
    expect(resolveColor('aqua')).toBe(resolveColor('cyan'))
    expect(resolveColor('fuchsia')).toBe(resolveColor('magenta'))
    expect(resolveColor('gray')).toBe(resolveColor('grey'))
    expect(resolveColor('darkgray')).toBe(resolveColor('darkgrey'))
  })

  it('rebeccapurple (CSS 4 addition) → #663399', () => {
    expect(resolveColor('rebeccapurple')).toBe('#663399')
  })

  it('transparent → 8-digit hex with alpha=0', () => {
    expect(resolveColor('transparent')).toBe('#00000000')
  })

  it('unknown name → null', () => {
    expect(resolveColor('not-a-color')).toBeNull()
    expect(resolveColor('mycolor')).toBeNull()
    expect(resolveColor('')).toBeNull()
  })
})

describe('CSS color functions — parse coverage (iter 547)', () => {
  const FORMS: Array<[string, string]> = [
    ['rgb(255, 0, 0)', 'legacy comma rgb'],
    ['rgba(255, 0, 0, 0.5)', 'legacy comma rgba'],
    ['rgb(255 0 0)', 'modern space rgb'],
    ['rgb(255 0 0 / 0.5)', 'modern slash-alpha'],
    ['rgba(255 0 0 / 50%)', 'modern percent alpha'],
    ['rgb(100%, 0%, 0%)', 'percent channels'],
    ['hsl(120, 50%, 50%)', 'legacy hsl'],
    ['hsla(0, 100%, 50%, 0.25)', 'legacy hsla'],
    ['hsl(120 50% 50%)', 'modern hsl'],
    ['hsl(120 50% 50% / 0.5)', 'modern hsl slash-alpha'],
  ]

  for (const [str, label] of FORMS) {
    it(`${label}: ${str}`, () => {
      const result = resolveColor(str)
      expect(result, `${str} should parse`).not.toBeNull()
      expect(result).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    })
  }
})

describe('CSS hex literals (iter 547)', () => {
  it('all four hex lengths', () => {
    expect(resolveColor('#f00')).toBe('#f00')
    expect(resolveColor('#f00a')).toBe('#f00a')
    expect(resolveColor('#ff0000')).toBe('#ff0000')
    expect(resolveColor('#ff0000aa')).toBe('#ff0000aa')
  })

  it('case-insensitive', () => {
    expect(resolveColor('#FF0000')).toBe('#ff0000')
  })

  it('invalid lengths rejected', () => {
    expect(resolveColor('#12')).toBeNull()
    expect(resolveColor('#12345')).toBeNull()
    expect(resolveColor('#1234567')).toBeNull()
  })
})

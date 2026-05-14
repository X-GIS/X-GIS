// Tailwind-compatible color palette for X-GIS design tokens
// Usage: resolveColor("red-500") → "#ef4444"

const PALETTE: Record<string, Record<number, string>> = {
  slate: {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8',
    500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617',
  },
  gray: {
    50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af',
    500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712',
  },
  zinc: {
    50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa',
    500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b',
  },
  neutral: {
    50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3',
    500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a',
  },
  stone: {
    50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e',
    500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09',
  },
  red: {
    50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171',
    500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a',
  },
  orange: {
    50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c',
    500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407',
  },
  amber: {
    50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24',
    500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03',
  },
  yellow: {
    50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15',
    500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006',
  },
  lime: {
    50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635',
    500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05',
  },
  green: {
    50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80',
    500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16',
  },
  emerald: {
    50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399',
    500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22',
  },
  teal: {
    50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf',
    500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e',
  },
  cyan: {
    50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee',
    500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344',
  },
  sky: {
    50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8',
    500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49',
  },
  blue: {
    50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa',
    500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554',
  },
  indigo: {
    50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8',
    500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b',
  },
  violet: {
    50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa',
    500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065',
  },
  purple: {
    50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc',
    500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764',
  },
  fuchsia: {
    50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9',
    500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e',
  },
  pink: {
    50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6',
    500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724',
  },
  rose: {
    50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185',
    500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519',
  },
}

// ─────────────────────────────────────────────────────────────────
// CSS named colors (Color Module Level 4, 147 X11 + rebeccapurple +
// transparent = 148 entries). Lowercase only — resolveColor lowers
// the input before lookup. Verbatim values from
// https://www.w3.org/TR/css-color-4/#named-colors.
//
// Naming overlap with the Tailwind PALETTE keys ('red', 'blue',
// 'green', etc.) is intentional and resolves correctly because the
// dispatch is identifier-shape-based, not name-based:
//
//   - Bare identifier  ('red')      → NAMED_COLORS lookup  → "#ff0000"
//   - Hyphenated form  ('red-500')  → PALETTE['red'][500]  → "#ef4444"
//
// So Tailwind utilities (`fill-red-500`) and CSS named colors
// (`fill-red`) coexist without ambiguity.
// ─────────────────────────────────────────────────────────────────
const NAMED_COLORS: Record<string, string> = {
  // Special
  transparent:          '#00000000',
  // Greyscale + neutrals
  white:                '#ffffff',
  black:                '#000000',
  silver:               '#c0c0c0',
  gray:                 '#808080',
  grey:                 '#808080',
  dimgray:              '#696969',
  dimgrey:              '#696969',
  lightgray:            '#d3d3d3',
  lightgrey:            '#d3d3d3',
  darkgray:             '#a9a9a9',
  darkgrey:             '#a9a9a9',
  slategray:            '#708090',
  slategrey:            '#708090',
  lightslategray:       '#778899',
  lightslategrey:       '#778899',
  darkslategray:        '#2f4f4f',
  darkslategrey:        '#2f4f4f',
  gainsboro:            '#dcdcdc',
  // Reds + pinks
  red:                  '#ff0000',
  darkred:              '#8b0000',
  firebrick:            '#b22222',
  crimson:              '#dc143c',
  indianred:            '#cd5c5c',
  lightcoral:           '#f08080',
  salmon:               '#fa8072',
  darksalmon:           '#e9967a',
  lightsalmon:          '#ffa07a',
  pink:                 '#ffc0cb',
  lightpink:            '#ffb6c1',
  hotpink:              '#ff69b4',
  deeppink:             '#ff1493',
  palevioletred:        '#db7093',
  mediumvioletred:      '#c71585',
  // Oranges + browns
  tomato:               '#ff6347',
  orangered:            '#ff4500',
  coral:                '#ff7f50',
  orange:               '#ffa500',
  darkorange:           '#ff8c00',
  brown:                '#a52a2a',
  saddlebrown:          '#8b4513',
  sienna:               '#a0522d',
  chocolate:            '#d2691e',
  peru:                 '#cd853f',
  rosybrown:            '#bc8f8f',
  sandybrown:           '#f4a460',
  goldenrod:            '#daa520',
  darkgoldenrod:        '#b8860b',
  tan:                  '#d2b48c',
  burlywood:            '#deb887',
  // Yellows
  gold:                 '#ffd700',
  yellow:               '#ffff00',
  lightyellow:          '#ffffe0',
  lemonchiffon:         '#fffacd',
  lightgoldenrodyellow: '#fafad2',
  papayawhip:           '#ffefd5',
  moccasin:             '#ffe4b5',
  peachpuff:            '#ffdab9',
  palegoldenrod:        '#eee8aa',
  khaki:                '#f0e68c',
  darkkhaki:            '#bdb76b',
  // Greens
  greenyellow:          '#adff2f',
  chartreuse:           '#7fff00',
  lawngreen:            '#7cfc00',
  lime:                 '#00ff00',
  limegreen:            '#32cd32',
  yellowgreen:          '#9acd32',
  olive:                '#808000',
  darkolivegreen:       '#556b2f',
  olivedrab:            '#6b8e23',
  darkseagreen:         '#8fbc8f',
  palegreen:            '#98fb98',
  lightgreen:           '#90ee90',
  forestgreen:          '#228b22',
  green:                '#008000',
  darkgreen:            '#006400',
  mediumseagreen:       '#3cb371',
  seagreen:             '#2e8b57',
  springgreen:          '#00ff7f',
  mediumspringgreen:    '#00fa9a',
  mediumaquamarine:     '#66cdaa',
  aquamarine:           '#7fffd4',
  // Cyans / teals
  aqua:                 '#00ffff',
  cyan:                 '#00ffff',
  lightcyan:            '#e0ffff',
  paleturquoise:        '#afeeee',
  turquoise:            '#40e0d0',
  mediumturquoise:      '#48d1cc',
  darkturquoise:        '#00ced1',
  darkcyan:             '#008b8b',
  teal:                 '#008080',
  cadetblue:            '#5f9ea0',
  lightseagreen:        '#20b2aa',
  // Blues
  steelblue:            '#4682b4',
  lightsteelblue:       '#b0c4de',
  powderblue:           '#b0e0e6',
  lightblue:            '#add8e6',
  skyblue:              '#87ceeb',
  lightskyblue:         '#87cefa',
  deepskyblue:          '#00bfff',
  dodgerblue:           '#1e90ff',
  cornflowerblue:       '#6495ed',
  royalblue:            '#4169e1',
  blue:                 '#0000ff',
  mediumblue:           '#0000cd',
  darkblue:             '#00008b',
  navy:                 '#000080',
  midnightblue:         '#191970',
  // Purples
  blueviolet:           '#8a2be2',
  indigo:               '#4b0082',
  darkslateblue:        '#483d8b',
  slateblue:            '#6a5acd',
  mediumslateblue:      '#7b68ee',
  mediumpurple:         '#9370db',
  rebeccapurple:        '#663399',
  purple:               '#800080',
  darkmagenta:          '#8b008b',
  darkviolet:           '#9400d3',
  darkorchid:           '#9932cc',
  mediumorchid:         '#ba55d3',
  thistle:              '#d8bfd8',
  plum:                 '#dda0dd',
  violet:               '#ee82ee',
  magenta:              '#ff00ff',
  fuchsia:              '#ff00ff',
  orchid:               '#da70d6',
  maroon:               '#800000',
  // Off-whites
  ivory:                '#fffff0',
  snow:                 '#fffafa',
  floralwhite:          '#fffaf0',
  ghostwhite:           '#f8f8ff',
  seashell:             '#fff5ee',
  oldlace:              '#fdf5e6',
  beige:                '#f5f5dc',
  whitesmoke:           '#f5f5f5',
  linen:                '#faf0e6',
  antiquewhite:         '#faebd7',
  bisque:               '#ffe4c4',
  blanchedalmond:       '#ffebcd',
  wheat:                '#f5deb3',
  cornsilk:             '#fff8dc',
  honeydew:             '#f0fff0',
  azure:                '#f0ffff',
  aliceblue:            '#f0f8ff',
  lavender:             '#e6e6fa',
  lavenderblush:        '#fff0f5',
  mistyrose:            '#ffe4e1',
  mintcream:            '#f5fffa',
  // Misc
  navajowhite:          '#ffdead',
}

/**
 * Resolve a design token color name to hex.
 * Examples: "red-500" → "#ef4444", "white" → "#ffffff", "blue-400" → "#60a5fa"
 * Also recognises CSS colour functions:
 *   rgb(255, 0, 0)              → "#ff0000"
 *   rgba(0, 0, 0, 0.5)          → "#00000080"
 *   rgb(255, 0, 0, 0.5)         → "#ff000080"   (CSS-modern syntax)
 *   hsl(120, 50%, 50%)          → "#40bf40"
 *   hsla(0, 100%, 50%, 0.25)    → "#ff000040"
 * Returns null if unrecognized.
 */
export function resolveColor(name: string): string | null {
  // Hex literals pass through. Accepted shapes:
  //   #rgb / #rgba / #rrggbb / #rrggbbaa
  // Without this, utility classes that bake a hex directly into the
  // name (`fill-#3399cc`) drop their colour at resolveUtilities time
  // — the converter from Mapbox styles emits these everywhere.
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(name)) {
    return name.toLowerCase()
  }

  // CSS named colors are case-insensitive per spec; lowercase the
  // input so `CornflowerBlue`, `RED`, etc. match the table.
  const lower = name.toLowerCase()
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower]

  // CSS rgb/rgba/hsl/hsla function — try before the palette regex
  // so `rgb(255,0,0)` doesn't fall through to "Expected utility
  // name" or get mistaken for an identifier-shade pair.
  const fn = parseCssColorFn(name)
  if (fn) return fn

  // Parse "color-shade" pattern
  const match = name.match(/^([a-z]+)-(\d+)$/)
  if (!match) return null

  const [, colorName, shade] = match
  const palette = PALETTE[colorName]
  if (!palette) return null

  return palette[parseInt(shade)] ?? null
}

/** Parse a CSS rgb / rgba / hsl / hsla function call into a `#RRGGBB`
 *  or `#RRGGBBAA` string. Accepts comma-separated and modern slash-
 *  separated alpha (`rgb(0 0 0 / 0.5)`). Returns null when the
 *  input isn't a recognized colour function. */
function parseCssColorFn(input: string): string | null {
  // Strip whitespace inside but keep the structure tokens
  const trimmed = input.trim()
  const m = trimmed.match(/^(rgb|rgba|hsl|hsla)\((.*)\)$/i)
  if (!m) return null
  const fn = m[1].toLowerCase()
  // Accept comma OR whitespace separation; the CSS-modern alpha
  // separator is `/` (e.g. `rgb(255 0 0 / 0.5)`).
  const inner = m[2].replace(/\//g, ',')
  const parts = inner.split(/[,\s]+/).filter(p => p.length > 0)
  if (parts.length < 3 || parts.length > 4) return null

  if (fn === 'rgb' || fn === 'rgba') {
    const r = parseChannel(parts[0], 255)
    const g = parseChannel(parts[1], 255)
    const b = parseChannel(parts[2], 255)
    if (r === null || g === null || b === null) return null
    if (parts.length === 4) {
      const a = parseAlpha(parts[3])
      if (a === null) return null
      return rgbToHex(r, g, b, a)
    }
    return rgbToHex(r, g, b, 1)
  }

  // hsl / hsla
  const h = parseHue(parts[0])
  const sat = parsePercent(parts[1])
  const lig = parsePercent(parts[2])
  if (h === null || sat === null || lig === null) return null
  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1
  if (alpha === null) return null
  const [r, g, b] = hslToRgb(h, sat, lig)
  return rgbToHex(r, g, b, alpha)
}

function parseChannel(p: string, fullScale: number): number | null {
  // Percent form: "50%" → 0.5 × fullScale
  if (p.endsWith('%')) {
    const v = parseFloat(p.slice(0, -1))
    if (!Number.isFinite(v)) return null
    return clamp01(v / 100) * fullScale
  }
  const v = parseFloat(p)
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(fullScale, v))
}

function parsePercent(p: string): number | null {
  if (!p.endsWith('%')) {
    const v = parseFloat(p)
    if (!Number.isFinite(v)) return null
    // CSS spec actually requires `%` for hsl S/L, but tolerate the
    // unitless 0-100 form (e.g. `hsl(120, 50, 50)`) to be forgiving.
    return clamp01(v / 100)
  }
  const v = parseFloat(p.slice(0, -1))
  if (!Number.isFinite(v)) return null
  return clamp01(v / 100)
}

function parseAlpha(p: string): number | null {
  if (p.endsWith('%')) {
    const v = parseFloat(p.slice(0, -1))
    return Number.isFinite(v) ? clamp01(v / 100) : null
  }
  const v = parseFloat(p)
  return Number.isFinite(v) ? clamp01(v) : null
}

function parseHue(p: string): number | null {
  // Accepts plain degrees, "<n>deg", or "<n>turn".
  const m = p.match(/^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/i)
  if (!m) return null
  let v = parseFloat(m[1])
  if (!Number.isFinite(v)) return null
  const unit = (m[2] ?? 'deg').toLowerCase()
  if (unit === 'turn') v *= 360
  else if (unit === 'rad') v *= 180 / Math.PI
  else if (unit === 'grad') v *= 0.9
  return ((v % 360) + 360) % 360
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = h / 360
  const r = hueToRgb(p, q, hk + 1 / 3)
  const g = hueToRgb(p, q, hk)
  const b = hueToRgb(p, q, hk - 1 / 3)
  return [r * 255, g * 255, b * 255]
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function rgbToHex(r: number, g: number, b: number, a: number): string {
  const ri = Math.round(r), gi = Math.round(g), bi = Math.round(b)
  const ai = Math.round(a * 255)
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return a >= 0.999
    ? `#${hex(ri)}${hex(gi)}${hex(bi)}`
    : `#${hex(ri)}${hex(gi)}${hex(bi)}${hex(ai)}`
}

// ═══ Categorical Encoder ═══
// Maps string property values to integer category IDs for GPU storage buffer.
// All string processing happens at compile/load time — GPU only sees integers.

import { resolveColor } from '../tokens/colors'
import { hexToRgba } from '../ir/render-node'

// 20 maximally-distinct colors from Tailwind palette (500 shades)
const AUTO_PALETTE_TOKENS = [
  'red-500', 'blue-500', 'green-500', 'amber-500', 'purple-500',
  'cyan-500', 'pink-500', 'lime-500', 'orange-500', 'teal-500',
  'indigo-500', 'yellow-500', 'emerald-500', 'rose-500', 'sky-500',
  'violet-500', 'fuchsia-500', 'stone-500', 'slate-500', 'zinc-500',
]

let autoPalette: [number, number, number, number][] | null = null

function getAutoPalette(): [number, number, number, number][] {
  if (autoPalette) return autoPalette
  autoPalette = AUTO_PALETTE_TOKENS.map(token => {
    const hex = resolveColor(token)
    return hex ? hexToRgba(hex) : [0.5, 0.5, 0.5, 1.0] as [number, number, number, number]
  })
  return autoPalette
}

/**
 * Generate WGSL const array for the auto-categorical palette.
 */
export function generatePaletteWGSL(paletteSize = 20): string {
  const palette = getAutoPalette()
  const entries = palette.slice(0, paletteSize)
    .map(([r, g, b, a]) => `  vec4f(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}, ${a.toFixed(3)})`)
    .join(',\n')
  return `const CAT_PALETTE: array<vec4f, ${paletteSize}> = array<vec4f, ${paletteSize}>(\n${entries}\n);`
}

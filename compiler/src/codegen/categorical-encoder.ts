// ═══ Categorical Encoder ═══
// Maps string property values to integer category IDs for GPU storage buffer.
// All string processing happens at compile/load time — GPU only sees integers.

import type { PropertyTable } from '../tiler/vector-tiler'
import { resolveColor } from '../tokens/colors'
import { hexToRgba } from '../ir/render-node'

export interface CategoricalEncoding {
  fieldName: string
  categories: Map<string, number>  // "KOR" → 0, "JPN" → 1
  palette: [number, number, number, number][]  // RGBA per category
}

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
 * Build categorical encoding from a PropertyTable field.
 * Unique string values are sorted alphabetically and assigned 0-based IDs.
 */
export function buildCategoricalEncoding(
  table: PropertyTable,
  fieldName: string,
): CategoricalEncoding | null {
  const fieldIdx = table.fieldNames.indexOf(fieldName)
  if (fieldIdx < 0) return null
  if (table.fieldTypes[fieldIdx] !== 'string') return null

  // Collect unique values
  const uniqueValues = new Set<string>()
  for (const row of table.values) {
    const val = row[fieldIdx]
    if (val != null && typeof val === 'string') {
      uniqueValues.add(val)
    }
  }

  // Sort alphabetically for deterministic IDs
  const sorted = [...uniqueValues].sort()
  const categories = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    categories.set(sorted[i], i)
  }

  const palette = getAutoPalette()

  return { fieldName, categories, palette }
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

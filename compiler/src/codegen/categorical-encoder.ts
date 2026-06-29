// ═══ Categorical Encoder ═══
// Maps string property values to integer category IDs for GPU storage buffer.
// All string processing happens at compile/load time — GPU only sees integers.

import { resolveColor } from '../tokens/colors'
import { hexToRgba } from '../ir/render-node'
import { arrayT, vec4fT, emitConst, type ConstDecl, type Expr } from '@xgis/shader-dsl'
import { vec4fFromRgba } from './_util/node-builders'

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
 * Build the auto-categorical palette as a first-class IR module constant —
 * an `array<vec4<f32>, N>` whose value is an IR literal expression. The array
 * const support landed generically in `@xgis/shader-dsl` (`ConstDecl.valueExpr`),
 * so the palette is authored as IR rather than a hand-assembled WGSL string;
 * the backend `emitConst` spells it.
 */
export function buildCatPaletteConst(paletteSize = 20): ConstDecl {
  const palette = getAutoPalette()
  const type = arrayT(vec4fT, paletteSize)
  const args = palette.slice(0, paletteSize).map(rgba => vec4fFromRgba(rgba).expr as Expr)
  return {
    name: 'CAT_PALETTE',
    type,
    wgslValue: 0,
    cpuValue: 0,
    valueExpr: { op: 'construct', type, args },
  }
}

/**
 * Generate the WGSL `const CAT_PALETTE` declaration. Thin wrapper that emits the
 * IR `ConstDecl` from `buildCatPaletteConst` through the shader-dsl backend.
 */
export function generatePaletteWGSL(paletteSize = 20): string {
  return emitConst(buildCatPaletteConst(paletteSize))
}

// ═══ Categorical Encoder ═══
// Maps string property values to integer category IDs for GPU storage buffer.
// All string processing happens at compile/load time — GPU only sees integers.

import { resolveColor } from '../tokens/colors'
import { hexToRgba } from '../ir/render-node'
import { arrayT, vec4fT, type ConstDecl, type Expr } from '@xgis/shader-dsl'
import { vec4fFromRgba } from './_util/node-builders'

// 20 maximally-distinct colors from Tailwind palette (500 shades)
const AUTO_PALETTE_TOKENS = [
  'red-500',
  'blue-500',
  'green-500',
  'amber-500',
  'purple-500',
  'cyan-500',
  'pink-500',
  'lime-500',
  'orange-500',
  'teal-500',
  'indigo-500',
  'yellow-500',
  'emerald-500',
  'rose-500',
  'sky-500',
  'violet-500',
  'fuchsia-500',
  'stone-500',
  'slate-500',
  'zinc-500',
]

/**
 * Number of colours in the auto-categorical palette — the SINGLE source of
 * truth for the `CAT_PALETTE[u32(field) % N]` index wrap. The shader modulo
 * bound (`shader-gen.ts`) and this const array's length are BOTH derived from
 * it, so they can never silently diverge into color collisions (issue #724).
 *
 * 512 rather than the original 20 (#2439). The number is set by the largest
 * distinct-category count in the shipped corpus — `countries.geojson` carries
 * 258 distinct `name` values — rounded up to the next power of two so the
 * flagship `categorical()` demos are collision-FREE rather than merely
 * collision-reduced. Costs ~20 KiB of literal text in each shader that uses
 * `categorical()`; 256 would halve that and leave 2 of 258 countries sharing
 * a colour, which is the trade this number rejects.
 *
 * WHAT THIS DOES AND DOES NOT PROMISE. Past ~20-30 entries, golden-angle hues
 * are ~1.4 degrees apart and no human tells them apart, so the guarantee is
 * "no two categories share a colour", NOT "every category is distinguishable"
 * (#724 asked for the latter; it is not achievable at 258). Adjacent regions
 * with different values stop merging into one shape, and picking/legend stay
 * honest — that is the win.
 *
 * REACHING THE PROMISE ALSO NEEDS A DENSE INDEX, which is a separate half
 * living in the runtime packer: the palette slot is `id % N`, and where `id`
 * is `stableCategoryId`'s 23-bit hash (a real MVT/PMTiles source, whose
 * distinct set is never final) collisions are a BIRTHDAY bound over N, not a
 * pigeonhole one — ~65 of 258 would still collide at N=512. A source seeded
 * from a complete FeatureCollection gets a dense rank instead and lands one
 * category per slot. See #2439 and `feature-data-pack.ts`.
 */
export const CAT_PALETTE_SIZE = 512

type Rgba = [number, number, number, number]

/** Golden-angle hue with short co-prime saturation / value cycles.
 *
 *  The hue step is the golden ratio conjugate, whose distinctness guarantee is
 *  a property of CONSECUTIVE INTEGERS: by the three-distance theorem the gaps
 *  in `{frac(i·phi) : i < D}` take at most three values, all about `1/D`. So a
 *  DENSE index gets maximally-spread hues at every prefix length, with no
 *  arbitrary cutoff — the reason this beats picking N colours for a fixed N.
 *  (Fed a HASHED index the same expression is merely random and collides on
 *  the birthday bound; that asymmetry is why #2439's runtime half exists.)
 *
 *  S and V cycle on periods 3 and 6 so two entries that land close in hue
 *  still differ in another channel. `catPaletteDistinct` in the test file
 *  asserts the whole array is pairwise distinct in 8-bit RGB — the promise is
 *  verified, not argued. */
function goldenAngleRgba(i: number): Rgba {
  const h = (i * 0.618033988749895) % 1
  const s = 0.55 + 0.15 * (i % 3)
  const v = 0.98 - 0.22 * (Math.floor(i / 3) % 2)
  // HSV -> RGB, branchless (the standard `k = (n + h*6) mod 6` formulation).
  const ch = (n: number): number => {
    const k = (n + h * 6) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [ch(5), ch(3), ch(1), 1.0]
}

let autoPalette: Rgba[] | null = null

function getAutoPalette(): Rgba[] {
  if (autoPalette) return autoPalette
  // The first 20 stay the hand-picked Tailwind tokens: they vary in lightness
  // as well as hue, so at the small category counts most styles actually have
  // they read better than anything a single-formula sequence produces. Past
  // them the count is beyond human discrimination anyway (see
  // CAT_PALETTE_SIZE), so a formula is exactly right.
  const out: Rgba[] = AUTO_PALETTE_TOKENS.map((token) => {
    const hex = resolveColor(token)
    return hex ? hexToRgba(hex) : ([0.5, 0.5, 0.5, 1.0] as Rgba)
  })
  for (let i = out.length; i < CAT_PALETTE_SIZE; i++) out.push(goldenAngleRgba(i))
  autoPalette = out
  return autoPalette
}

/**
 * Build the auto-categorical palette as a first-class IR module constant —
 * an `array<vec4<f32>, N>` whose value is an IR literal expression. The array
 * const support landed generically in `@xgis/shader-dsl` (`ConstDecl.valueExpr`),
 * so the palette is authored as IR rather than a hand-assembled WGSL string;
 * the backend `emitConst` spells it.
 */
export function buildCatPaletteConst(paletteSize = CAT_PALETTE_SIZE): ConstDecl {
  const palette = getAutoPalette()
  const type = arrayT(vec4fT, paletteSize)
  // `slice(0, paletteSize)` alone emitted `array<vec4f, N>` with min(20, N)
  // initializers — a WGSL type error for any N past the hand-picked tokens,
  // unreachable only because both call sites passed no argument (#2439 step 2
  // §7). Synthesizing past the end makes the declared length and the supplied
  // count equal BY CONSTRUCTION, at every N, so the parameter now means what
  // it reads as.
  const args = Array.from(
    { length: paletteSize },
    (_, i) => vec4fFromRgba(palette[i] ?? goldenAngleRgba(i)).expr as Expr,
  )
  return {
    name: 'CAT_PALETTE',
    type,
    wgslValue: 0,
    cpuValue: 0,
    valueExpr: { op: 'construct', type, args },
  }
}

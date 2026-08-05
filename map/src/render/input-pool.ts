// ═══ The reserved `input` uniform pool — the ONE place its field names live ═══
//
// `polygonU` carries 12 reserved lanes (`input_f32_0..7`, `input_color_0..3`)
// that a declared `input` (#1539) is assigned a fixed slot in by the COMPILER,
// in declaration order, independently per type. `astToNode` emits a real
// `u.input_f32_N` / `u.input_color_N` read for each — never the bare-Identifier
// `0.0` fallback that makes an unrecognised name silently compile to zero.
//
// WHY A POOL AND NOT A CPU EVALUATION. `optimize.ts`'s optimizeOpacity /
// optimizeColor fold a `data-driven` paint value only when `classifyExpr`
// returns `'constant'`, so an `input-dependent` opacity or colour stays
// data-driven and reaches shader codegen; map has no per-frame CPU
// re-evaluation of paint values to route it through instead. The shader read is
// the only path, which is also why `setInput` can be a pure uniform write with
// no pipeline rebuild.
//
// WHY 12 SCALAR LANES AND NOT 2 PACKED ARRAYS. `UniformBlock` rejects array
// fields at construction outright (engine/src/render/uniform-block.ts:113-121,
// "keep its bespoke packer"), so `array<vec4<f32>, 2>` is not available; the
// lanes must be plain scalar/vec fields.
//
// WHY ONLY POLYGON CARRIES IT. The compiler's variant codegen hardcodes the
// `u.` prefix (`u.fill_color`, `u.zoom`) — that is polygonU's `as: 'u'` binding
// — and `fillExpr`/`strokeExpr` are consumed only by polygon-shader-cache.ts /
// pipeline-factory.ts. Line (`as: 'tile'`/`'layer'`) and point never receive a
// generated expression, so a pool there would be dead bytes on every draw.
//
// WHY THE NAMES LIVE HERE. Four writers need these 12 lanes — VTR's four
// frameBlock sites plus the three `write({…})` packers — and all four files sit
// exactly on their shrink-only LOC ceilings. Spelling the lanes once here keeps
// each call site a single line, and gives the VTR completeness gate one file to
// scan instead of a rule per writer.

import type { UniformBlockOf } from '@xgis/engine'
import type { polygonU } from '../shaders/dsl/polygon'
import type { InputStore } from './input-store'

type PolygonBlock = UniformBlockOf<typeof polygonU>

/** The pool's contribution to a full-struct `write({…})`. Pass `null` for a
 *  path with no user inputs (graticule, the pick pass) — the lanes go to zero,
 *  which is what a shader that reads no input sees anyway. */
export function inputPoolValues(store: InputStore | null): {
  input_f32_0: number
  input_f32_1: number
  input_f32_2: number
  input_f32_3: number
  input_f32_4: number
  input_f32_5: number
  input_f32_6: number
  input_f32_7: number
  input_color_0: [number, number, number, number]
  input_color_1: [number, number, number, number]
  input_color_2: [number, number, number, number]
  input_color_3: [number, number, number, number]
} {
  const f = store?.f32Slots
  const c = store?.colorSlots
  const col = (i: number): [number, number, number, number] =>
    c ? [c[i * 4]!, c[i * 4 + 1]!, c[i * 4 + 2]!, c[i * 4 + 3]!] : [0, 0, 0, 0]
  return {
    input_f32_0: f?.[0] ?? 0,
    input_f32_1: f?.[1] ?? 0,
    input_f32_2: f?.[2] ?? 0,
    input_f32_3: f?.[3] ?? 0,
    input_f32_4: f?.[4] ?? 0,
    input_f32_5: f?.[5] ?? 0,
    input_f32_6: f?.[6] ?? 0,
    input_f32_7: f?.[7] ?? 0,
    input_color_0: col(0),
    input_color_1: col(1),
    input_color_2: col(2),
    input_color_3: col(3),
  }
}

/** Patch the pool lanes of an already-populated block. Called once per frame
 *  from each site that establishes the frame-constant uniforms (mvp /
 *  proj_params / globe_eye): the block is REUSED across tiles, so a
 *  frame-constant write persists into every per-tile writeBuffer and costs
 *  nothing per tile. */
export function writeInputPool(block: PolygonBlock, store: InputStore | null): void {
  const v = inputPoolValues(store)
  block.set.input_f32_0(v.input_f32_0)
  block.set.input_f32_1(v.input_f32_1)
  block.set.input_f32_2(v.input_f32_2)
  block.set.input_f32_3(v.input_f32_3)
  block.set.input_f32_4(v.input_f32_4)
  block.set.input_f32_5(v.input_f32_5)
  block.set.input_f32_6(v.input_f32_6)
  block.set.input_f32_7(v.input_f32_7)
  block.set.input_color_0(...v.input_color_0)
  block.set.input_color_1(...v.input_color_1)
  block.set.input_color_2(...v.input_color_2)
  block.set.input_color_3(...v.input_color_3)
}

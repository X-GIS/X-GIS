// ═══ Shader DSL — SDF shape graph (PoC-B: the imperative thesis) ═══
//
// Re-authors runtime/src/engine/shaders/sdf.ts WGSL_SDF_SHAPE (+ the three
// dist_to_* helpers + winding_line) as IR. This is the proof that the
// imperative statement-list nodes (for-loop, switch, var, compound assign
// min=/+=, early return, nested if) lower correctly on BOTH backends — the
// architectural unknown the projection PoC (pure expressions + dispatch)
// could not retire. The hardest production shader (compute_line_color) is
// this same machinery at scale; PoC-B de-risks it before the line family.

import {
  fn, module, f32, i32, u32, vec2,
  f32T, i32T, u32T, vec2fT,
  clamp, min, max, length, dot, mix, toF32, select,
  Loop, reduce, If, Switch, Return, assign, addAssign,
  type FuncDecl, type ModuleDecl,
} from '../core/ir'
import { structDecl, storageBuffer } from '../core/sot'
import { emitFuncsCsed, emitStruct } from '../core/backends/wgsl'

// Storage structs (match sdf-shape.ts byte layout; field types drive access).
export const ShapeDesc = structDecl('ShapeDesc', {
  seg_start: u32T, seg_count: u32T,
  bbox_min_x: f32T, bbox_min_y: f32T, bbox_max_x: f32T, bbox_max_y: f32T,
  _pad0: f32T, _pad1: f32T,
})
export const ShapeSegment = structDecl('ShapeSegment', {
  kind: u32T, color_idx: u32T, flags: u32T, _pad: u32T,
  p0: vec2fT, p1: vec2fT, p2: vec2fT, p3: vec2fT,
})


// Storage bindings the sdf_shape reads (group 0; bindings illustrative — the
// real layout is wired at migration time, Phase 2).
const shapesB = storageBuffer('shapes', ShapeDesc, { group: 0, binding: 8, access: 'read' })
const segmentsB = storageBuffer('segments', ShapeSegment, { group: 0, binding: 9, access: 'read' })

// ── dist_to_segment / quadratic / cubic / winding_line ──

export const dist_to_segment = fn('dist_to_segment', { p: vec2fT, a: vec2fT, b: vec2fT }, f32T, ({ p, a, b }) => {
  const ab = b.sub(a)
  const len2 = dot(ab, ab)
  // single-exit: max() guards the degenerate (len2≈0) divide; select picks the point dist.
  const t = clamp(dot(p.sub(a), ab).div(max(len2, 1e-10)), f32(0), f32(1))
  const segDist = length(p.sub(a).sub(ab.mul(t)))
  return select(len2.lt(1e-10), length(p.sub(a)), segDist)
})

export const dist_to_quadratic = fn('dist_to_quadratic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT }, f32T, ({ p, a, b, c }) => {
  const STEPS = u32(16)
  return reduce(f32(1e10), u32(0), (i) => i.le(STEPS), (best, i) => {
    const t = toF32(i).div(toF32(STEPS))
    const ab = mix(a, b, t)
    const bc = mix(b, c, t)
    const q = mix(ab, bc, t)
    return min(best, length(p.sub(q)))
  }, u32(1))
})

export const dist_to_cubic = fn('dist_to_cubic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT, d: vec2fT }, f32T, ({ p, a, b, c, d }) => {
  const STEPS = u32(24)
  return reduce(f32(1e10), u32(0), (i) => i.le(STEPS), (best, i) => {
    const t = toF32(i).div(toF32(STEPS))
    const ab = mix(a, b, t)
    const bc = mix(b, c, t)
    const cd = mix(c, d, t)
    const abc = mix(ab, bc, t)
    const bcd = mix(bc, cd, t)
    const q = mix(abc, bcd, t)
    return min(best, length(p.sub(q)))
  }, u32(1))
})

export const winding_line = fn('winding_line', { p: vec2fT, a: vec2fT, b: vec2fT }, i32T, ({ p, a, b }) => {
  // single-exit: signed winding contribution of edge a→b across the +y ray from p.
  const cross = b.x.sub(a.x).mul(p.y.sub(a.y)).sub(p.x.sub(a.x).mul(b.y.sub(a.y)))
  const up = a.y.le(p.y).and(b.y.gt(p.y)).and(cross.gt(0))
  const down = a.y.gt(p.y).and(b.y.le(p.y)).and(cross.lt(0))
  return select(up, i32(1), select(down, i32(-1), i32(0)))
})

// ── sdf_shape (the imperative core: bbox cull + segment loop + switch) ──

const sdf_shape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, ({ uv_in, shape_id }) => {
  const uv = vec2(uv_in.x, uv_in.y.neg())
  const s = shapesB.at(shape_id)

  If(
    uv.x.lt(s.bbox_min_x).or(uv.x.gt(s.bbox_max_x))
      .or(uv.y.lt(s.bbox_min_y)).or(uv.y.gt(s.bbox_max_y)),
    () => { Return(f32(2)) },
  )

  // No Var ceremony — written as plain consts; the auto-vars emit pass sees the
  // later assign/addAssign and materialises each as a WGSL `var`.
  const min_dist = f32(1e10)
  const winding = i32(0)
  const end = min(s.seg_start.add(s.seg_count), s.seg_start.add(u32(32)))

  Loop(s.seg_start, (i) => i.lt(end), (i) => {
    const seg = segmentsB.at(i)
    Switch(seg.kind, [
      [0, () => {
        assign(min_dist, min(min_dist, dist_to_segment(uv, seg.p0, seg.p1)))
        addAssign(winding, winding_line(uv, seg.p0, seg.p1))
      }],
      [1, () => {
        assign(min_dist, min(min_dist, dist_to_quadratic(uv, seg.p0, seg.p1, seg.p2)))
        addAssign(winding, winding_line(uv, seg.p0, seg.p2))
      }],
      [2, () => {
        assign(min_dist, min(min_dist, dist_to_cubic(uv, seg.p0, seg.p1, seg.p2, seg.p3)))
        addAssign(winding, winding_line(uv, seg.p0, seg.p3))
      }],
    ], () => { /* default: {} */ })
  }, u32(1))

  If(winding.ne(i32(0)), () => { Return(f32(1).sub(min_dist)) })
  Return(f32(1).add(min_dist))
}, { allowEarlyReturn: true }) // MISRA single-exit DEVIATION — the out-of-bbox guard skips a 32-iter segment loop (perf)

// ── Module assembly ──

export const SDF_FUNCS: FuncDecl[] = [
  dist_to_segment, dist_to_quadratic, dist_to_cubic, winding_line, sdf_shape,
]

export const SDF_MODULE: ModuleDecl = module({
  structs: [ShapeDesc.decl, ShapeSegment.decl],
  bindings: [shapesB.binding, segmentsB.binding],
  funcs: SDF_FUNCS,
})

// ── Emitted WGSL (Phase 2: shaders/sdf.ts re-exports these) ──
// line-renderer-shaders.ts inlines the individual dist/winding fns + the
// shape structs. Emitted from the same IR PoC-B verified.
const fnByName = (name: string): FuncDecl => {
  const f = SDF_FUNCS.find((x) => x.name === name)
  if (!f) throw new Error(`sdf-dsl: missing fn ${name}`)
  return f
}
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const SDF_WGSL_DIST_TO_QUADRATIC = `${emitFuncsCsed([fnByName('dist_to_quadratic')])}\n`
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const SDF_WGSL_DIST_TO_CUBIC = `${emitFuncsCsed([fnByName('dist_to_cubic')])}\n`
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const SDF_WGSL_SHAPE = `${emitFuncsCsed([fnByName('sdf_shape')])}\n`
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const SDF_WGSL_SHAPE_STRUCTS = `${emitStruct(ShapeDesc.decl)}\n\n${emitStruct(ShapeSegment.decl)}\n`

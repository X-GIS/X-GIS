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
  f32T, i32T, u32T, vec2fT, arrayT, bindingRef,
  clamp, min, max, length, dot, mix, toF32, select,
  Let, Var, Loop, assign,
  type FuncDecl, type ModuleDecl,
} from '../core/ir'
import { struct } from '../core/schema'
import { emitFuncsCsed, emitStruct } from '../core/backends/wgsl'

// Storage structs (match sdf-shape.ts byte layout; field types drive access).
export const ShapeDesc = struct('ShapeDesc', {
  seg_start: u32T, seg_count: u32T,
  bbox_min_x: f32T, bbox_min_y: f32T, bbox_max_x: f32T, bbox_max_y: f32T,
  _pad0: f32T, _pad1: f32T,
})
export const ShapeSegment = struct('ShapeSegment', {
  kind: u32T, color_idx: u32T, flags: u32T, _pad: u32T,
  p0: vec2fT, p1: vec2fT, p2: vec2fT, p3: vec2fT,
})

const sd = ShapeDesc.get
const sg = ShapeSegment.get

// Storage bindings the sdf_shape reads (group 0; bindings illustrative — the
// real layout is wired at migration time, Phase 2).
const shapes = bindingRef('shapes', arrayT(ShapeDesc.type))
const segments = bindingRef('segments', arrayT(ShapeSegment.type))

// ── dist_to_segment / quadratic / cubic / winding_line ──

export const dist_to_segment = fn('dist_to_segment', { p: vec2fT, a: vec2fT, b: vec2fT }, f32T, ({ p, a, b }, _b) => {
  const ab = Let('ab', b.sub(a))
  const len2 = Let('len2', dot(ab, ab))
  // single-exit: max() guards the degenerate (len2≈0) divide; select picks the point dist.
  const t = Let('t', clamp(dot(p.sub(a), ab).div(max(len2, 1e-10)), f32(0), f32(1)))
  const segDist = Let('seg_dist', length(p.sub(a).sub(ab.mul(t))))
  return select(len2.lt(1e-10), length(p.sub(a)), segDist)
})

export const dist_to_quadratic = fn('dist_to_quadratic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT }, f32T, ({ p, a, b, c }, _b) => {
  const best_d = Var('best_d', f32T, f32(1e10))
  const STEPS = Let('STEPS', u32(16))
  Loop('i', u32(0), (i) => i.le(STEPS), (i) => {
    const t = Let('t', toF32(i).div(toF32(STEPS)))
    const ab = Let('ab', mix(a, b, t))
    const bc = Let('bc', mix(b, c, t))
    const q = Let('q', mix(ab, bc, t))
    assign(best_d, min(best_d, length(p.sub(q))))
  }, u32(1))
  return best_d
})

export const dist_to_cubic = fn('dist_to_cubic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT, d: vec2fT }, f32T, ({ p, a, b, c, d }, _b) => {
  const best_d = Var('best_d', f32T, f32(1e10))
  const STEPS = Let('STEPS', u32(24))
  Loop('i', u32(0), (i) => i.le(STEPS), (i) => {
    const t = Let('t', toF32(i).div(toF32(STEPS)))
    const ab = Let('ab', mix(a, b, t))
    const bc = Let('bc', mix(b, c, t))
    const cd = Let('cd', mix(c, d, t))
    const abc = Let('abc', mix(ab, bc, t))
    const bcd = Let('bcd', mix(bc, cd, t))
    const q = Let('q', mix(abc, bcd, t))
    assign(best_d, min(best_d, length(p.sub(q))))
  }, u32(1))
  return best_d
})

export const winding_line = fn('winding_line', { p: vec2fT, a: vec2fT, b: vec2fT }, i32T, ({ p, a, b }, _b) => {
  // single-exit: signed winding contribution of edge a→b across the +y ray from p.
  const cross = Let('cross_val', b.x.sub(a.x).mul(p.y.sub(a.y)).sub(p.x.sub(a.x).mul(b.y.sub(a.y))))
  const up = a.y.le(p.y).and(b.y.gt(p.y)).and(cross.gt(0))
  const down = a.y.gt(p.y).and(b.y.le(p.y)).and(cross.lt(0))
  return select(up, i32(1), select(down, i32(-1), i32(0)))
})

// ── sdf_shape (the imperative core: bbox cull + segment loop + switch) ──

const sdf_shape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, ({ uv_in, shape_id }, bld) => {
  const uv = bld.let('uv', vec2(uv_in.x, uv_in.y.neg()))
  const s = bld.let('s', shapes.at(shape_id, ShapeDesc.type))

  bld.if(
    uv.x.lt(sd(s, 'bbox_min_x')).or(uv.x.gt(sd(s, 'bbox_max_x')))
      .or(uv.y.lt(sd(s, 'bbox_min_y'))).or(uv.y.gt(sd(s, 'bbox_max_y'))),
    (c) => { c.ret(f32(2)) },
  )

  const min_dist = bld.var('min_dist', f32T, f32(1e10))
  const winding = bld.var('winding', i32T, i32(0))
  const end = bld.let('end', min(sd(s, 'seg_start').add(sd(s, 'seg_count')), sd(s, 'seg_start').add(u32(32))))

  bld.forRange('i', sd(s, 'seg_start'), (i) => i.lt(end), (loop, i) => {
    const seg = loop.let('seg', segments.at(i, ShapeSegment.type))
    loop.switch(sg(seg, 'kind'), [
      [0, (c) => {
        c.assign(min_dist, min(min_dist, dist_to_segment(uv, sg(seg, 'p0'), sg(seg, 'p1'))))
        c.addAssign(winding, winding_line(uv, sg(seg, 'p0'), sg(seg, 'p1')))
      }],
      [1, (c) => {
        c.assign(min_dist, min(min_dist, dist_to_quadratic(uv, sg(seg, 'p0'), sg(seg, 'p1'), sg(seg, 'p2'))))
        c.addAssign(winding, winding_line(uv, sg(seg, 'p0'), sg(seg, 'p2')))
      }],
      [2, (c) => {
        c.assign(min_dist, min(min_dist, dist_to_cubic(uv, sg(seg, 'p0'), sg(seg, 'p1'), sg(seg, 'p2'), sg(seg, 'p3'))))
        c.addAssign(winding, winding_line(uv, sg(seg, 'p0'), sg(seg, 'p3')))
      }],
    ], () => { /* default: {} */ })
  }, u32(1))

  bld.if(winding.ne(i32(0)), (c) => { c.ret(f32(1).sub(min_dist)) })
  bld.ret(f32(1).add(min_dist))
}, { allowEarlyReturn: true }) // MISRA single-exit DEVIATION — the out-of-bbox guard skips a 32-iter segment loop (perf)

// ── Module assembly ──

export const SDF_FUNCS: FuncDecl[] = [
  dist_to_segment, dist_to_quadratic, dist_to_cubic, winding_line, sdf_shape,
]

export const SDF_MODULE: ModuleDecl = module({
  structs: [ShapeDesc.decl, ShapeSegment.decl],
  bindings: [
    { group: 0, binding: 8, name: 'shapes', space: 'storage', access: 'read', type: arrayT(ShapeDesc.type) },
    { group: 0, binding: 9, name: 'segments', space: 'storage', access: 'read', type: arrayT(ShapeSegment.type) },
  ],
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
export const SDF_WGSL_DIST_TO_SEGMENT = `${emitFuncsCsed([fnByName('dist_to_segment')])}\n`
export const SDF_WGSL_DIST_TO_QUADRATIC = `${emitFuncsCsed([fnByName('dist_to_quadratic')])}\n`
export const SDF_WGSL_DIST_TO_CUBIC = `${emitFuncsCsed([fnByName('dist_to_cubic')])}\n`
export const SDF_WGSL_WINDING_LINE = `${emitFuncsCsed([fnByName('winding_line')])}\n`
export const SDF_WGSL_SHAPE = `${emitFuncsCsed([fnByName('sdf_shape')])}\n`
export const SDF_WGSL_SHAPE_STRUCTS = `${emitStruct(ShapeDesc.decl)}\n\n${emitStruct(ShapeSegment.decl)}\n`

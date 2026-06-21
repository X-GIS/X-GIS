// ═══ Shader DSL — overdraw debug compose (Phase 4+ migration) ═══
//
// Re-authors the `?debug=overdraw` compose pipeline's WGSL (formerly
// inlined in renderer.ts:587). Fullscreen triangle samples the
// r16float overdraw accumulator and writes a heat-colormapped RGBA
// to the swapchain. SampleCount = 1 (debug mode forces MSAA off in
// `quality.ts`); pipeline never needs MSAA variants.
//
// The shader is non-polygon-variant (no fillExpr / strokeExpr swap)
// so the polygon DSL composer doesn't apply — this is a standalone
// emit helper that returns the compose pipeline's WGSL.

import {
  entryFn, fn, module, bindingRef, callFn,
  f32, u32, vec2, vec3, vec4, toF32, toI32,
  clamp,
  textureLoad, textureDimensions, vec2i,
  f32T, u32T, vec2fT, vec3fT, vec4fT, texture2dfT,
  structT,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}

const accumTex = bindingRef('accum_tex', texture2dfT)

// Heat colormap — black → blue → green → yellow → red → white. Tuned
// so 1-2 overdraws are visibly cool, 8 mid-warm, 16+ saturated red.
// 4-stop piecewise (polynomial fit, no branching): dark navy → cyan →
// yellow → red.

const colormap = fn('colormap', { t: f32T }, vec3fT, (b, p) => {
  const s = b.let('s', clamp(p.t, f32(0), f32(1)))
  const r = b.let('r', clamp(s.mul(f32(3)).sub(f32(0.5)), f32(0), f32(1)))
  const g = b.let('g',
    clamp(s.mul(f32(2.5)), f32(0), f32(1))
      .mul(clamp(f32(2).sub(s.mul(f32(2))), f32(0), f32(1))),
  )
  const blue = b.let('b', clamp(f32(0.6).sub(s.mul(f32(1.5))), f32(0), f32(1)))
  b.ret(vec3(r, g, blue))
})

// Oversized fullscreen triangle (3 vertices, NDC −1..3 in each axis).
// Same trick as the OIT compose pass — covers the screen with no vertex
// buffer + a single triangle.

const vsFull = entryFn(
  'vs_full', 'vertex',
  [{ name: 'idx', type: u32T, builtin: 'vertex_index' }],
  structT('VsOut'),
  (b, p) => {
    const pos = b.var('pos', vec2fT, vec2(f32(-1), f32(-1)))
    b.if(p.idx.eq(u32(1)), (c) => { c.assign(pos, vec2(f32(3), f32(-1))) })
      .elif(p.idx.eq(u32(2)), (c) => { c.assign(pos, vec2(f32(-1), f32(3))) })
    const out = b.var('out', structT('VsOut'))
    b.assign(out.field('pos', vec4fT), vec4(pos, f32(0), f32(1)))
    // y-flip — texture origin top-left, NDC origin bottom-left.
    b.assign(out.field('uv', vec2fT),
      vec2(
        pos.x.add(f32(1)).mul(f32(0.5)),
        f32(1).sub(pos.y.add(f32(1)).mul(f32(0.5))),
      ),
    )
    b.ret(out)
  },
)

// fs_compose — query the overdraw accumulator at this pixel's texel
// coord, exposure-map count → colormap. 16 overdraws fully saturate;
// tunable in 8..32 range (label-heavy ↔ extruded-building scenes).

const fsCompose = entryFn(
  'fs_compose', 'fragment',
  [{ name: 'in', type: structT('VsOut') }],
  vec4fT,
  (b, p) => {
    // textureDimensions returns vec2<u32>; toF32 each component for the
    // uv → texel-coord multiply. WGSL doesn't auto-convert across
    // signed/unsigned/float in vec construction, so the conversion is
    // explicit.
    const dimU = b.let('dim_u', textureDimensions(accumTex))
    const dim = b.let('dim', vec2(toF32(dimU.x), toF32(dimU.y)))
    const uv = b.let('uv', vec2i(toI32(p.in.field('uv', vec2fT).x.mul(dim.x)), toI32(p.in.field('uv', vec2fT).y.mul(dim.y))))
    const count = b.let('count', textureLoad(accumTex, uv, u32(0)).x)
    b.if(count.lt(f32(0.5)), (c) => {
      // No fragments → empty pixel; leave dark to distinguish from "1 draw".
      c.ret(vec4(f32(0.02), f32(0.02), f32(0.04), f32(1)))
    })
    // Exposure: 16 overdraws → fully saturated.
    const t = b.let('t', count.div(f32(16)))
    b.ret(vec4(callFn('colormap', vec3fT, t), f32(1)))
  },
  '@location(0)',
)

const overdrawComposeModule: ModuleDecl = module({
  structs: [VsOut],
  bindings: [
    { group: 0, binding: 0, name: 'accum_tex', space: 'uniform', type: texture2dfT },
  ],
  funcs: [colormap, vsFull, fsCompose],
})

/** Overdraw debug compose pipeline's full WGSL source. Drop-in for the
 *  inline wgsl-tag template renderer.ts:587 previously held; the
 *  pipeline still creates the same shader module + bind-group layout. */
export const emitOverdrawComposeWgsl = (): string => emitModule(overdrawComposeModule)

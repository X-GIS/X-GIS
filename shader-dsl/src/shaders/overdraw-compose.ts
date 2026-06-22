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
  fn, module, callFn,
  f32, u32, vec2, vec3, vec4, toF32, toI32,
  clamp,
  textureLoad, textureDimensions, vec2i,
  f32T, u32T, vec2fT, vec3fT, vec4fT, texture2dfT,
  If, Return, assign,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const accumTex = resource('accum_tex', texture2dfT, { group: 0, binding: 0 })

// Heat colormap — black → blue → green → yellow → red → white. Tuned
// so 1-2 overdraws are visibly cool, 8 mid-warm, 16+ saturated red.
// 4-stop piecewise (polynomial fit, no branching): dark navy → cyan →
// yellow → red.

const colormap = fn('colormap', { t: f32T }, vec3fT, (p) => {
  const s = clamp(p.t, f32(0), f32(1))
  const r = clamp(s.mul(f32(3)).sub(f32(0.5)), f32(0), f32(1))
  const g = clamp(s.mul(f32(2.5)), f32(0), f32(1))
      .mul(clamp(f32(2).sub(s.mul(f32(2))), f32(0), f32(1)))
  const blue = clamp(f32(0.6).sub(s.mul(f32(1.5))), f32(0), f32(1))
  Return(vec3(r, g, blue))
})

// Oversized fullscreen triangle (3 vertices, NDC −1..3 in each axis).
// Same trick as the OIT compose pass — covers the screen with no vertex
// buffer + a single triangle.

const vsFull = fn(
  'vs_full', { idx: builtin('vertex_index', u32T) },
  VsOut.type,
  (p) => {
    const pos = vec2(f32(-1), f32(-1))
    If(p.idx.eq(u32(1)), () => { assign(pos, vec2(f32(3), f32(-1))) })
      .elif(p.idx.eq(u32(2)), () => { assign(pos, vec2(f32(-1), f32(3))) })
    // y-flip — texture origin top-left, NDC origin bottom-left.
    return VsOut.construct({
      pos: vec4(pos, f32(0), f32(1)),
      uv: vec2(
        pos.x.add(f32(1)).mul(f32(0.5)),
        f32(1).sub(pos.y.add(f32(1)).mul(f32(0.5))),
      ),
    })
  },
  { stage: 'vertex' },
)

// fs_compose — query the overdraw accumulator at this pixel's texel
// coord, exposure-map count → colormap. 16 overdraws fully saturate;
// tunable in 8..32 range (label-heavy ↔ extruded-building scenes).

const fsCompose = fn(
  'fs_compose', { in: VsOut.type },
  vec4fT,
  (p) => {
    const pin = VsOut.of(p.in)
    // textureDimensions returns vec2<u32>; toF32 each component for the
    // uv → texel-coord multiply. WGSL doesn't auto-convert across
    // signed/unsigned/float in vec construction, so the conversion is
    // explicit.
    const dimU = textureDimensions(accumTex.node)
    const dim = vec2(toF32(dimU.x), toF32(dimU.y))
    const uv = vec2i(toI32(pin.uv.x.mul(dim.x)), toI32(pin.uv.y.mul(dim.y)))
    const count = textureLoad(accumTex.node, uv, u32(0)).x
    If(count.lt(f32(0.5)), () => {
      // No fragments → empty pixel; leave dark to distinguish from "1 draw".
      Return(vec4(f32(0.02), f32(0.02), f32(0.04), f32(1)))
    })
    // Exposure: 16 overdraws → fully saturated.
    const t = count.div(f32(16))
    Return(vec4(callFn('colormap', vec3fT, t), f32(1)))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const overdrawComposeModule: ModuleDecl = module({
  structs: [VsOut.decl],
  bindings: [accumTex.binding],
  funcs: [colormap, vsFull, fsCompose],
})

/** Overdraw debug compose pipeline's full WGSL source. Drop-in for the
 *  inline wgsl-tag template renderer.ts:587 previously held; the
 *  pipeline still creates the same shader module + bind-group layout. */
export const emitOverdrawComposeWgsl = (): string => emitModule(overdrawComposeModule)

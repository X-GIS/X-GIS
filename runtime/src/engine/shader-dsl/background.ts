// ═══ Shader DSL — background shader (Phase 2: first standalone render shader) ═══
//
// Re-authors background-renderer.ts BG_SHADER_SOURCE on the render-stage IR.
// The earth-surface fill: a world-extent quad (6 verts) projected by the camera
// MVP, fragment = the style background colour. The pick variant (an extra
// flat-interpolated varying + a pick output) is now CONDITIONAL EMISSION
// (`pickEnabled` param) instead of the `__PICK_*__` String.replace markers —
// the PoC-C parameterized-emission pattern.

import {
  entryFn, bindingRef, arrayLit, transformMat4, vec2, vec4, vec2u, f32, u32,
  constRef, module, structT, f32T, mat4x4fT, vec2fT, vec4fT, vec2uT, u32T,
  type StructDecl, type ConstDecl, type ModuleDecl,
} from './ir'
import { emitModule } from './backend-wgsl'

// iter-196 world-extent quad constants (see background-renderer.ts).
const BG_CONSTS: ConstDecl[] = [
  { name: 'WORLD_MERC', type: f32T, wgslValue: 40075016.686, cpuValue: 40075016.686 },
  { name: 'MAX_Y', type: f32T, wgslValue: 20037508.34, cpuValue: 20037508.34 },
]
const WORLD_MERC = constRef('WORLD_MERC')
const MAX_Y = constRef('MAX_Y')

const U: StructDecl = {
  name: 'U',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'cam_center', type: vec2fT },
    { name: '_pad', type: vec2fT },
    { name: 'color', type: vec4fT },
  ],
}
const u = bindingRef('u', structT('U'))

/** Build the bg shader module. `pickEnabled` toggles the pick varying/output
 *  (the former __PICK_FIELD__ / __PICK_OUT_FIELD__ / __PICK_WRITE__ markers). */
function buildBgModule(pickEnabled: boolean): ModuleDecl {
  const VOut: StructDecl = {
    name: 'VOut',
    fields: [
      { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
      ...(pickEnabled ? [{ name: '_pad', type: u32T, attr: '@location(0) @interpolate(flat)' }] : []),
    ],
  }
  const FOut: StructDecl = {
    name: 'FOut',
    fields: [
      { name: 'color', type: vec4fT, attr: '@location(0)' },
      ...(pickEnabled ? [{ name: 'pick', type: vec2uT, attr: '@location(1)' }] : []),
    ],
  }

  // World-extent quad: 5-world-copy wide in X (±2.5 worlds), Y at ±MAX_Y.
  // Camera-relative (subtract cam_center → RTC) before the MVP.
  const vs = entryFn('vs', 'vertex', [{ name: 'idx', type: u32T, builtin: 'vertex_index' }], structT('VOut'), (b, { idx }) => {
    const X = b.let('X', WORLD_MERC.mul(2.5))
    const Y = b.let('Y', MAX_Y)
    const p = b.let('p', arrayLit(vec2fT,
      vec2(X.neg(), Y.neg()), vec2(X, Y.neg()), vec2(X.neg(), Y),
      vec2(X.neg(), Y), vec2(X, Y.neg()), vec2(X, Y)))
    const local = b.let('local', p.at(idx, vec2fT).sub(u.field('cam_center', vec2fT)))
    const out = b.var('out', structT('VOut'))
    b.assign(out.field('pos', vec4fT), transformMat4(u.field('mvp', mat4x4fT), vec4(local, f32(0), f32(1))))
    b.ret(out)
  })

  const fs = entryFn('fs', 'fragment', [{ name: 'in', type: structT('VOut') }], structT('FOut'), (b) => {
    const out = b.var('out', structT('FOut'))
    b.assign(out.field('color', vec4fT), u.field('color', vec4fT))
    if (pickEnabled) b.assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    b.ret(out)
  })

  return module({
    consts: BG_CONSTS,
    structs: [U, VOut, FOut],
    bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('U') }],
    funcs: [vs, fs],
  })
}

/** Emit the bg shader WGSL. background-renderer.ts builds the main pipeline with
 *  `emitBgWgsl(isPickEnabled())` and the overdraw pipeline with
 *  `emitBgWgsl(false) + OVERDRAW_FS_SOURCE`. */
export const emitBgWgsl = (pickEnabled: boolean): string => emitModule(buildBgModule(pickEnabled))

export { buildBgModule }

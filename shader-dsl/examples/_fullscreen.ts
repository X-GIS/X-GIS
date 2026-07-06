// ═══ @xgis/shader-dsl examples — shared fullscreen-pass boilerplate (#840) ═══
//
// Every fullscreen example used to repeat the same ~20 lines: the {time,
// resolution} uniform head, the VsOut ioStruct, and the fullscreen-triangle
// vertex stage derived from vertex_index. They live here ONCE — a pure
// extraction, proven by the emit goldens staying byte-identical — so each
// example declares only its fragment stage and its extra uniform fields.
//
// The GLSL subtlety now lives in one place: gl_VertexID is int, so the u32
// vertex_index param needs the uint() cast the backend inserts — pinned by
// the emit gate in examples.test.ts.

import {
  fn,
  ioStruct,
  uniformStruct,
  u32,
  toF32,
  vec2,
  vec4,
  location,
  builtin,
  f32T,
  vec2fT,
  vec4fT,
  u32T,
  type Node,
  type ReadonlyNode,
  type ShaderType,
  type UniformStruct,
} from '../src/index.ts'

/** vertex→fragment IO: clip position (builtin) + the screen uv in [0,1]². */
export const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

/** Fullscreen triangle: 3 verts covering the screen, uv in [0,1]. No vertex
 *  buffer — position is derived from the vertex index alone. */
export const vs = fn(
  'vs',
  { vi: builtin('vertex_index', u32T) },
  ({ vi }) => {
    const x = toF32(vi.bitAnd(u32(1)))
      .mul(4)
      .sub(1) // -1, 3, -1
    const y = toF32(vi.shr(u32(1)))
      .mul(4)
      .sub(1) // -1, -1, 3
    return VsOut.construct({
      pos: vec4(x, y, 0, 1),
      uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)),
    })
  },
  { stage: 'vertex' },
)

/** The standard {time, resolution, …extra} uniform at @group(0) @binding(0),
 *  std140 layout recovered by reflect(). Extra fields keep declaration order
 *  AFTER time/resolution — field order is the byte layout. */
/** Centred, ISOTROPIC screen coordinates from the fullscreen uv (#842): y spans
 *  ±1 over the height and x spans ±aspect over the width, so ONE unit covers
 *  the same number of pixels on both axes — distances and shapes computed in
 *  this space render undistorted (a circle stays a circle). Mixing this space
 *  with raw [0,1] uv units caused a real bug (the ocean example's elliptical
 *  sun). Pure node-graph sugar — it builds the exact ops of the hand-written
 *  form, so adopting it is emit-byte-identical. */
export function screenCoords(
  uv: ReadonlyNode<'vec2<f32>'>,
  resolution: ReadonlyNode<'vec2<f32>'>,
): Node<'vec2<f32>'> {
  const asp = resolution.x.div(resolution.y)
  return vec2(uv.x.mul(2).sub(1).mul(asp), uv.y.mul(2).sub(1))
}

export function fullscreenUniforms<F extends Record<string, ShaderType>>(
  extra?: F,
): UniformStruct<{ time: typeof f32T; resolution: typeof vec2fT } & F> {
  return uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, {
    time: f32T,
    resolution: vec2fT,
    ...(extra ?? ({} as F)),
  } as { time: typeof f32T; resolution: typeof vec2fT } & F)
}

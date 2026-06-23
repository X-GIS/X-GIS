// ═══ @xgis/shader-dsl example — a ShaderToy plasma, authored in the DSL ═══
//
// Ports the classic ShaderToy plasma (sum-of-sines → palette) to the DSL: a
// fullscreen-triangle vertex stage + a fragment stage driven by a {time,
// resolution} uniform. Emits WGSL + its pipeline Reflection — the metadata a
// host needs to build the bind-group layout + pack the uniform.
//
// This is a DOGFOODING example: it authors a real screen shader (not a string
// demo) so the host can render it. Run:  npx tsx examples/shadertoy-plasma.ts

import {
  fn, module, uniformStruct, ioStruct,
  f32, u32, toF32, vec2, vec3, vec4, sin, location, builtin,
  f32T, vec2fT, vec4fT, u32T,
  emitModuleWithReflection, emitGlslModule, wgslBackend,
} from '../src/index.ts'

// {time, resolution} uniform — std140 layout recovered by reflect().
const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT })

// vertex→fragment IO: clip position (builtin) + the screen uv.
const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

// Fullscreen triangle: 3 verts covering the screen, uv in [0,1].
const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1) // -1, 3, -1
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)    // -1, -1, 3
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

const fs = fn('fs', { in: VsOut.type }, ({ in: i }) => {
  const t = U.field.time
  const uv = VsOut.of(i).uv
  // sum-of-sines plasma field
  const v = sin(uv.x.mul(10).add(t))
    .add(sin(uv.y.mul(10).add(t)))
    .add(sin(uv.x.add(uv.y).mul(10).add(t.mul(0.7))))
  // map the field through an RGB palette
  const col = vec3(sin(v), sin(v.add(2.094)), sin(v.add(4.188))).mul(0.5).add(0.5)
  return vec4(col, 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const plasma = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

// Backend selection: same DSL source → WGSL (WebGPU) or GLSL ES 3.00 (WebGL2).
const { code: wgsl, reflection } = emitModuleWithReflection(plasma, wgslBackend)
console.log('=== WGSL (WebGPU) ===\n' + wgsl)

console.log('\n=== GLSL ES 3.00 (WebGL2) ===')
try {
  console.log(emitGlslModule(plasma))
} catch (e) {
  // Known gap: the GLSL backend does not yet lower a @builtin VERTEX INPUT
  // (here `@builtin(vertex_index)`) to its gl_* global in the body. A fullscreen
  // triangle needs gl_VertexID, so this shader emits WGSL today but not GLSL.
  console.log(`(GLSL not emitted — ${(e as Error).message})`)
}

console.log('\n=== Reflection (the host binds from this) ===\n' + JSON.stringify(reflection, null, 2))

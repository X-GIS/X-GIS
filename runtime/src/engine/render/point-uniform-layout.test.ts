// Point uniform byte-layout consistency (reflection ↔ WGSL struct ↔ packer).
//
// Sibling of uniform-layout-consistency.test.ts (polygon). The point path once
// had a silent drift: the WGSL `struct Uniforms` placed `viewport` at f32 slot
// 20 (after tile_rtc was deleted), but the renderer wrote it at slot 24 — past
// the old Float32Array(24) bound — so the shader read an all-zero viewport and
// the NDC quad expansion divided by zero.
//
// Phase 3 (shader-dsl reflection): the renderer no longer hand-counts those
// slots — it sources them from `reflect(buildPointModule()).uniforms[0]` via
// `uniformFieldSlots(...)` (see point-renderer.ts / reflection-to-webgpu.ts).
// So this test no longer regex-scrapes the packer; it asserts the three views
// agree:
//   1. WGSL — the emitted `struct Uniforms`, parsed with an independent
//      std140 offset engine (the ground-truth the GPU actually sees);
//   2. reflection — `reflect(module).uniforms[0]`, the metadata the packer
//      reads its slots from;
//   3. the contracted slots (the documented byte layout).
// If reflection ever desyncs from the WGSL, (1) ≠ (2) fails here BEFORE the
// renderer can pack a field at the wrong offset.

import { describe, it, expect } from 'vitest'
import { reflect } from '@xgis/shader-dsl'
import { emitPointWgsl, buildPointModule } from '../shaders/dsl/point'
import { uniformFieldSlots } from './reflection-to-webgpu'

const WGSL_TYPES: Record<string, [number, number]> = {
  'mat4x4<f32>': [64, 16],
  'vec4<f32>': [16, 16],
  'vec2<f32>': [8, 8],
  'f32': [4, 4],
  'u32': [4, 4],
}

/** Independent oracle: parse the emitted WGSL `struct Uniforms` and compute its
 *  std140-aligned per-field f32 slot offsets + total size (bytes). */
function parsePointUniforms(): { slots: Record<string, number>; sizeBytes: number } {
  const src = emitPointWgsl()
  const m = src.match(/struct Uniforms \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('struct Uniforms not found in point DSL emit')
  const slots: Record<string, number> = {}
  let cursor = 0
  let maxAlign = 1
  for (const rawLine of m[1]!.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    const fm = line.match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/)
    if (!fm) continue
    const [, name, type] = fm
    const [size, align] = WGSL_TYPES[type!]!
    cursor = Math.ceil(cursor / align) * align
    slots[name!] = cursor / 4
    cursor += size
    if (align > maxAlign) maxAlign = align
  }
  return { slots, sizeBytes: Math.ceil(cursor / maxAlign) * maxAlign }
}

// Contracted slots — the documented point-uniform byte layout.
const CONTRACT = {
  mvp: 0,
  proj_params: 16,
  viewport: 20,
  cam_ecef_h: 24,
  cam_ecef_l: 28,
  circle_params: 32,
  globe_eye: 36, // #600 — globe(7) eye-horizon cull dir
}

describe('point uniform byte-layout consistency (reflection ↔ WGSL ↔ contract)', () => {
  const wgsl = parsePointUniforms()
  const refl = uniformFieldSlots(reflect(buildPointModule()), 'Uniforms')

  it('reflection slots equal the WGSL-parsed slots (no desync)', () => {
    expect(refl.slot).toEqual(wgsl.slots)
  })

  it('reflection slots equal the contracted point-uniform layout', () => {
    expect(refl.slot).toEqual(CONTRACT)
  })

  it('struct is 160 bytes / 40 f32 slots — exactly the renderer Float32Array', () => {
    // #600 — grew 144→160 (globe_eye vec4 @36 for the globe(7) eye-horizon cull).
    expect(wgsl.sizeBytes).toBe(160)
    expect(refl.slots).toBe(40)
  })
})

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
import { emitPointWgsl, buildPointModule } from '@xgis/map'
import { uniformFieldSlots } from '@xgis/rhi-webgpu'

const WGSL_TYPES: Record<string, [number, number]> = {
  'mat4x4<f32>': [64, 16],
  'vec4<f32>': [16, 16],
  'vec2<f32>': [8, 8],
  f32: [4, 4],
  u32: [4, 4],
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
  zoom: 40, // #1635 — camera zoom, the lane a stage block's `zoom` builtin reads
  mvp_pitch0: 44, // #2118 — the pitch-0 MVP, the ground basis's P₀ half
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

  it('struct is 240 bytes / 60 f32 slots — exactly the renderer Float32Array', () => {
    // #600 — grew 144→160 (globe_eye vec4 @36 for the globe(7) eye-horizon cull).
    // #1635 — grew 160→176: `zoom: f32` at slot 40 plus std140's 12 B tail pad to
    // the struct's 16 B alignment. The 3 pad slots are addressable but unwritten;
    // the next SCALAR lane added there costs zero extra bytes.
    // #2118 — grew 176→240: `mvp_pitch0: mat4x4<f32>` at slot 44. A mat4 needs the
    // 16 B alignment the tail pad had already reached, so it consumed those 3 pad
    // slots as its own leading alignment and added its 64 B on top. Appended AFTER
    // zoom, so no pre-existing field moved — the invariant every prior growth here
    // kept, and the reason the retired-lane byte reference below still holds.
    expect(wgsl.sizeBytes).toBe(240)
    expect(refl.slots).toBe(60)
  })
})

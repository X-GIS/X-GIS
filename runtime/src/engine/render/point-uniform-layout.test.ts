// Point uniform byte-layout consistency (CPU pack ↔ WGSL struct).
//
// Sibling of uniform-layout-consistency.test.ts (polygon). The point path had
// a silent drift: the WGSL `struct Uniforms` placed `viewport` at f32 slot 20
// (after tile_rtc was deleted), but the renderer wrote it at slot 24 — past
// the old Float32Array(24) bound — so the shader read an all-zero viewport and
// the NDC quad expansion divided by zero. This test parses the point Uniforms
// struct, computes WGSL-aligned offsets, and asserts the renderer's CPU pack
// (writePointFrameUniform) writes each field at its contracted slot.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitPointWgsl } from '../shaders/dsl/point'

const HERE = dirname(fileURLToPath(import.meta.url))

const WGSL_TYPES: Record<string, [number, number]> = {
  'mat4x4<f32>': [64, 16],
  'vec4<f32>': [16, 16],
  'vec2<f32>': [8, 8],
  'f32': [4, 4],
  'u32': [4, 4],
}

function parsePointUniforms(): { offsets: Record<string, number>; sizeBytes: number } {
  const src = emitPointWgsl()
  const m = src.match(/struct Uniforms \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('struct Uniforms not found in point DSL emit')
  const offsets: Record<string, number> = {}
  let cursor = 0
  let maxAlign = 1
  for (const rawLine of m[1]!.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    const fm = line.match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/)
    if (!fm) continue
    const [, name, type] = fm
    const [size, align] = WGSL_TYPES[type!]!
    cursor = Math.ceil(cursor / align) * align
    offsets[name!] = cursor / 4
    cursor += size
    if (align > maxAlign) maxAlign = align
  }
  return { offsets, sizeBytes: Math.ceil(cursor / maxAlign) * maxAlign }
}

describe('point uniform byte-layout consistency (CPU pack ↔ WGSL struct)', () => {
  const { offsets, sizeBytes } = parsePointUniforms()

  it('WGSL struct fields land at the contracted f32 offsets', () => {
    expect(offsets).toEqual({
      mvp: 0,
      proj_params: 16,
      viewport: 20,
      cam_ecef_h: 24,
      cam_ecef_l: 28,
      circle_params: 32,
    })
  })

  it('struct is 144 bytes — exactly the renderer Float32Array(36) / GPU buffer', () => {
    expect(sizeBytes).toBe(144)
  })

  it('writePointFrameUniform writes each field at its WGSL slot', () => {
    const src = readFileSync(join(HERE, 'point-renderer.ts'), 'utf8')
    // mvp @0
    expect(src).toMatch(/uf\.set\(frame\.matrix,\s*0\)/)
    // proj_params @16
    expect(src).toMatch(/uf\[16\]\s*=\s*projType/)
    // viewport @20 (the drift fix — was @24)
    expect(src).toMatch(/uf\[20\]\s*=\s*canvasWidth/)
    expect(src).toMatch(/uf\[23\]\s*=\s*frame\.logDepthFc/)
    // cam_ecef_h @24, cam_ecef_l @28 (DSFUN camera anchor)
    expect(src).toMatch(/uf\[24\]\s*=\s*cxH/)
    expect(src).toMatch(/uf\[28\]\s*=\s*camC\[0\]\s*-\s*cxH/)
    // circle_params @32-35: translate_x_ndc, translate_y_ndc, blur_px, _unused
    expect(src).toMatch(/uf\[32\]/)
    expect(src).toMatch(/uf\[33\]/)
    expect(src).toMatch(/uf\[34\]\s*=\s*circleBlur/)
    // uniformData sized to the full 36-slot struct.
    expect(src).toMatch(/uniformData\s*=\s*new Float32Array\(36\)/)
  })
})

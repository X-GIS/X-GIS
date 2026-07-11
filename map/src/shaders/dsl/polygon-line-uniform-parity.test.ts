// ═══ polygon Uniforms ↔ line TileUniforms byte-parity (shared VTR buffer) ═══
//
// VTR binds ONE group(0) uniform buffer that it WRITES with the polygon `Uniforms`
// layout (polygon.ts) but the line shader READS as `TileUniforms` (line.ts). The two
// DSL struct declarations therefore MUST agree byte-for-byte on every field the line
// shader reads from that shared buffer — polygon.ts owns the layout; line.ts mirrors
// it with `_pad_*` placeholders where it doesn't use a field.
//
// The pre-existing guard (line-dsl.test.ts) only asserts HARDCODED offset literals
// (cam_ecef_off_h===52, globe_eye===64, size===272) against line's own struct — it
// does NOT reflect polygon and compare, so a polygon-side layout change passes it
// while the line shader silently reads the wrong lanes (#998). This is that missing
// cross-check: reflect BOTH emitted structs and assert every shared-by-name field
// lands at the same offset, and the sizes match. No product code — test-only.

import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl } from './polygon'
import { emitLineWgsl } from './line'

// std140 sizes/alignments for the flat scalar/vector/mat4 fields both structs use.
const STD140: Record<string, [size: number, align: number]> = {
  'mat4x4<f32>': [64, 16],
  'vec4<f32>': [16, 16],
  'vec2<f32>': [8, 8],
  f32: [4, 4],
  u32: [4, 4],
  i32: [4, 4],
}

/** Byte offset of every field + std140 total size, parsed from an emitted WGSL struct body. */
function layout(wgsl: string, structName: string): { off: Record<string, number>; size: number } {
  const m = wgsl.match(new RegExp(`struct ${structName} \\{([\\s\\S]*?)\\n\\}`))
  if (!m) throw new Error(`struct ${structName} not found in emitted WGSL`)
  let cur = 0
  let maxA = 1
  const off: Record<string, number> = {}
  for (const raw of m[1]!.split('\n')) {
    const fm = raw
      .replace(/\/\/.*$/, '')
      .trim()
      .match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/)
    if (!fm) continue
    const sa = STD140[fm[2]!]
    if (!sa) throw new Error(`unmapped WGSL type '${fm[2]}' for field '${fm[1]}' — extend STD140`)
    const [size, align] = sa
    cur = Math.ceil(cur / align) * align
    off[fm[1]!] = cur
    cur += size
    if (align > maxA) maxA = align
  }
  return { off, size: Math.ceil(cur / maxA) * maxA }
}

describe('polygon Uniforms ↔ line TileUniforms byte-parity (#998)', () => {
  const poly = layout(emitPolygonWgsl(null, false), 'Uniforms')
  const line = layout(emitLineWgsl(false), 'TileUniforms')

  it('every field shared by name lands at the same byte offset in both structs', () => {
    const shared = Object.keys(poly.off).filter((f) => f in line.off)
    const mismatches = shared
      .filter((f) => poly.off[f] !== line.off[f])
      .map((f) => `${f}: polygon Uniforms @${poly.off[f]} vs line TileUniforms @${line.off[f]}`)
    expect(
      mismatches,
      'line reads these from VTR’s shared group(0) buffer — a differing offset corrupts every ' +
        `line draw. Re-align the line.ts _pad_* fields to polygon.ts:\n${mismatches.join('\n')}`,
    ).toEqual([])
  })

  it('both structs are the same total std140 size (shared buffer)', () => {
    expect(
      line.size,
      `line TileUniforms (${line.size}B) must equal polygon Uniforms (${poly.size}B)`,
    ).toBe(poly.size)
  })

  it('the cross-check is non-vacuous (the load-bearing shared fields are actually present)', () => {
    // Guards against a future rename silently emptying the shared set (a green-but-
    // meaningless test — the #996 vacuity lesson applied to this parity check).
    const shared = new Set(Object.keys(poly.off).filter((f) => f in line.off))
    for (const f of ['mvp', 'cam_ecef_off_h', 'cam_ecef_off_l', 'globe_eye']) {
      expect(
        shared.has(f),
        `expected shared field '${f}' in both structs — parity check would be vacuous`,
      ).toBe(true)
    }
    expect(shared.size).toBeGreaterThanOrEqual(10)
  })
})

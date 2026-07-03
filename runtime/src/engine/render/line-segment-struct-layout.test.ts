import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from '@xgis/map'
import { LINE_SEGMENT_STRIDE_BYTES, LINE_SEGMENT_STRIDE_F32 } from '@xgis/data'

// ═══ LineSegment storage-struct layout consistency (CPU writer ↔ WGSL reader) ═══
//
// vs_line is a storage-buffer renderer: the CPU (buildLineSegments) writes an
// array of LineSegment structs and the WGSL `struct LineSegment` (DSL) reads
// `segments[instance_index]`. Unlike vertex buffers, a stride mismatch here
// produces NO WebGPU validation error (the buffer size is valid) and SwiftShader
// CI skips line pixels — so nothing caught it. Uniforms have an equivalent gate
// (uniform-layout-consistency.test.ts); this is its storage-struct analogue.
//
// The element stride the GPU uses to index `array<LineSegment>` is the struct's
// std430 size. If the CPU uploads a different stride, segment[i] for i>=1 reads
// the wrong bytes → every multi-segment line / polygon stroke is corrupted.

// std430 [align, size] in bytes for the scalar/vector types LineSegment uses.
const STD430: Record<string, [number, number]> = {
  f32: [4, 4],
  u32: [4, 4],
  i32: [4, 4],
  'vec2<f32>': [8, 8],
  'vec2<u32>': [8, 8],
  'vec3<f32>': [16, 12],
  'vec4<f32>': [16, 16],
}

const roundUp = (x: number, a: number): number => Math.ceil(x / a) * a

/** std430 size (== array element stride) of a struct given its field types. */
function structStd430Size(fieldTypes: string[]): number {
  let offset = 0
  let maxAlign = 1
  for (const t of fieldTypes) {
    const info = STD430[t]
    if (!info) throw new Error(`std430: unknown type '${t}'`)
    const [align, size] = info
    offset = roundUp(offset, align) + size
    maxAlign = Math.max(maxAlign, align)
  }
  return roundUp(offset, maxAlign)
}

/** Extract a WGSL struct's field types in declaration order. */
function parseStructFieldTypes(wgsl: string, name: string): string[] {
  const m = wgsl.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\}`))
  if (!m) throw new Error(`WGSL struct ${name} not found`)
  const types: string[] = []
  const fieldRe = /\w+\s*:\s*([\w<>]+)\s*,/g
  let f: RegExpExecArray | null
  while ((f = fieldRe.exec(m[1]!)) !== null) types.push(f[1]!.trim())
  return types
}

describe('LineSegment storage-struct layout (CPU writer ↔ WGSL reader)', () => {
  const wgsl = emitLineWgsl(false)
  const fieldTypes = parseStructFieldTypes(wgsl, 'LineSegment')
  const wgslStride = structStd430Size(fieldTypes)

  it('CPU stride constant matches its declared float count', () => {
    expect(LINE_SEGMENT_STRIDE_BYTES).toBe(LINE_SEGMENT_STRIDE_F32 * 4)
  })

  // PR 2d.1A had grown the CPU stride to 26 floats (104 B) by appending unread
  // enu_p0/enu_p1 (slots 20-25) while the WGSL `struct LineSegment` stayed at
  // 20 floats (std430 stride 80 B) — so the GPU indexed array<LineSegment> with
  // an 80 B stride while the CPU uploaded 104 B/segment, corrupting segment[1+]
  // (invisible: storage buffers raise no validation error and SwiftShader can't
  // render the line path). The fix removed the unread enu slots, bringing the
  // CPU writer back to 20 floats to match the WGSL struct. This gate keeps the
  // two locked: if they diverge again (either side) it goes red.
  it('WGSL LineSegment std430 stride equals the CPU upload stride (no drift)', () => {
    expect(wgslStride).toBe(LINE_SEGMENT_STRIDE_BYTES)
  })

  it('both sides are 80 B / 20 floats', () => {
    expect(wgslStride).toBe(80)
    expect(LINE_SEGMENT_STRIDE_BYTES).toBe(80)
  })
})

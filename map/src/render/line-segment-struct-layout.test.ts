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

/** Field NAMES in the same declaration order — the offset map's key side. */
function parseStructFieldNames(wgsl: string, name: string): string[] {
  const m = wgsl.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\}`))
  if (!m) throw new Error(`WGSL struct ${name} not found`)
  const names: string[] = []
  const fieldRe = /(\w+)\s*:\s*[\w<>]+\s*,/g
  let f: RegExpExecArray | null
  while ((f = fieldRe.exec(m[1]!)) !== null) names.push(f[1]!)
  return names
}

describe('LineSegment storage-struct layout (CPU writer ↔ WGSL reader)', () => {
  const wgsl = emitLineWgsl(null, false)
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

  // #2089 grew both sides together (unlike 2d.1A's CPU-only append): slots
  // 20-31 are the per-endpoint CPU-exact ECEF RTC DSFUN lanes the globe
  // vs_line positions from.
  it('both sides are 128 B / 32 floats', () => {
    expect(wgslStride).toBe(128)
    expect(LINE_SEGMENT_STRIDE_BYTES).toBe(128)
  })

  // The stride check above is SIZE-ONLY, and every #2089 lane is an f32 — so
  // any permutation of them (or of a field swapped past them) keeps the struct
  // at 128 B and sails through it. That is not hypothetical: `buildLineSegments`
  // writes the lanes at LITERAL offsets (`off + 20`, `off + 26`), so a
  // stride-preserving reshuffle of the WGSL declaration silently repoints every
  // globe endpoint at the wrong lane — strokes drift toward the tile anchor
  // while fills stay put, i.e. #2053's symptom returns with all size gates
  // green. Storage buffers raise no validation error and the flat-arm gates
  // cannot see it. So pin the NAME→OFFSET map, not just the total.
  it('#2089 ECEF lane fields sit at the byte offsets the CPU writer uses', () => {
    const names = parseStructFieldNames(wgsl, 'LineSegment')
    const types = fieldTypes
    expect(names.length, 'name/type parse disagree').toBe(types.length)
    // std430 offset of each field, walked the same way structStd430Size does.
    const offsets = new Map<string, number>()
    let off = 0
    for (let i = 0; i < names.length; i++) {
      const info = STD430[types[i]!]!
      off = roundUp(off, info[0])
      offsets.set(names[i]!, off)
      off += info[1]
    }
    // buildLineSegments: writeEcefLanes(f0, off + 20) and (f1, off + 26),
    // each writing [x_h, y_h, z_h, x_l, y_l, z_l] in that order.
    const expected: [string, number][] = [
      ['e0x_h', 20 * 4],
      ['e0y_h', 21 * 4],
      ['e0z_h', 22 * 4],
      ['e0x_l', 23 * 4],
      ['e0y_l', 24 * 4],
      ['e0z_l', 25 * 4],
      ['e1x_h', 26 * 4],
      ['e1y_h', 27 * 4],
      ['e1z_h', 28 * 4],
      ['e1x_l', 29 * 4],
      ['e1y_l', 30 * 4],
      ['e1z_l', 31 * 4],
    ]
    for (const [name, byteOffset] of expected) {
      expect(offsets.get(name), `LineSegment.${name} byte offset`).toBe(byteOffset)
    }
  })
})

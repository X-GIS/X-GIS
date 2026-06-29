import { describe, it, expect } from 'vitest'
import { INTRINSICS, PORTABLE_INTRINSICS, isKnownIntrinsic } from './intrinsics'
import {
  f32, u32, bool, vec3, vec4,
  sin, cos, tan, asin, acos, atan, exp, log, log2, exp2, floor, ceil, abs, sqrt, fract,
  trunc, round, sign, radians, degrees, inverseSqrt, normalize,
  atan2, min, max, pow, clamp, mix, smoothstep, step, length, dot, distance, cross,
  pack4x8unorm, unpack4x8unorm, bitcastU32, toF32, toI32, toU32,
  type Node,
} from './ir'

describe('intrinsic registry coverage (the spelling agreement surface)', () => {
  it('no id is BOTH divergent and portable (single classification)', () => {
    const overlap = Object.keys(INTRINSICS).filter((k) => PORTABLE_INTRINSICS.has(k))
    expect(overlap).toEqual([])
  })

  it('every INTRINSICS entry is GENUINELY divergent (wgsl ≠ glsl) — a portable one belongs in the set, not the map', () => {
    const args = ['a', 'b', 'c'] // enough positional args for every entry's spelling
    const notDivergent = Object.entries(INTRINSICS).filter(([, s]) => s.wgsl(args) === s.glsl(args)).map(([k]) => k)
    expect(notDivergent).toEqual([])
  })

  // Deliberate-diff catalogue: adding/removing a classified builtin must touch this snapshot,
  // which forces the author to classify a new builtin as divergent (INTRINSICS) or portable.
  it('the full known-intrinsic catalogue is stable', () => {
    const catalogue = [...Object.keys(INTRINSICS), ...PORTABLE_INTRINSICS].sort()
    expect(catalogue).toMatchInlineSnapshot(`
      [
        "abs",
        "acos",
        "asin",
        "atan",
        "atan2",
        "bitcastU32",
        "ceil",
        "clamp",
        "cos",
        "cross",
        "degrees",
        "distance",
        "dot",
        "exp",
        "exp2",
        "f32",
        "floor",
        "fract",
        "fwidth",
        "i32",
        "inverseSqrt",
        "length",
        "log",
        "log2",
        "max",
        "min",
        "mix",
        "normalize",
        "pack4x8unorm",
        "pow",
        "radians",
        "round",
        "select",
        "sign",
        "sin",
        "smoothstep",
        "sqrt",
        "step",
        "storageFetchF32",
        "tan",
        "textureDimensions",
        "textureLoad",
        "textureSample",
        "trunc",
        "u32",
        "unpack4x8unorm",
      ]
    `)
  })

  it('every call id the builtin surface emits is classified (no silent identity fall-through)', () => {
    const f = f32(0), v3 = vec3(1, 2, 3), v4 = vec4(1, 2, 3, 4), u = u32(0)
    void bool(true)
    const samples: Node[] = [
      sin(f), cos(f), tan(f), asin(f), acos(f), atan(f), exp(f), log(f), log2(f), exp2(f),
      floor(f), ceil(f), abs(f), sqrt(f), fract(f), trunc(f), round(f), sign(f),
      radians(f), degrees(f), inverseSqrt(f), normalize(v3),
      atan2(f, f), min(f, f), max(f, f), pow(f, f), clamp(f, 0, 1), mix(f, f, f),
      smoothstep(0, 1, f), step(f, f), length(v3), dot(v3, v3), distance(v3, v3), cross(v3, v3),
      pack4x8unorm(v4), unpack4x8unorm(u), bitcastU32(f), toF32(u), toI32(f), toU32(f),
    ]
    const unclassified = samples
      .map((n) => n.expr)
      .filter((e): e is Extract<typeof e, { op: 'call' }> => e.op === 'call')
      .map((e) => e.fn)
      .filter((id) => !isKnownIntrinsic(id))
    expect(unclassified).toEqual([])
  })
})

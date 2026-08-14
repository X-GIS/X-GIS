// ═══ The storage data texture's FORMAT must match the sampler the shader declares (#1703) ═══
//
// WebGL2 has no SSBO, so a `usage: 'storage'` buffer is emulated as a data texture and
// shader-dsl's lowering reads it through a sampler whose type is fixed by the ELEMENT:
// `array<f32>` → `sampler2D`, `array<u32>` → `usampler2D`, `array<i32>` → `isampler2D`.
//
// Nothing enforces that pairing at runtime. A texture whose internal format disagrees with
// its sampler type is not an error — it is merely INCOMPLETE, and texelFetch on an
// incomplete texture silently returns 0. That is the same failure class as the #823
// stale-LINEAR-sampler bug: a zero-valued read, no GL error, no console warning.
//
// The end-to-end proof lives on a real driver (playground/e2e/_glsl-integer-texture-gate).
// These tests pin the host half in the fast leg, through REAL WebGl2Device calls against a
// bare fake context, so what is asserted is the actual code path and not a restatement of
// the table.

import { describe, expect, it } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

interface TexImageCall {
  internalFormat: number
  format: number
  type: number
}
interface TexSubImageCall {
  format: number
  type: number
  data: ArrayBufferView | null
}

// GL enums used by the storage path. Values are the real ones so a mix-up between two
// formats cannot coincidentally compare equal.
const E = {
  R32F: 0x822e,
  R32UI: 0x8236,
  R32I: 0x8235,
  RED: 0x1903,
  RED_INTEGER: 0x8d94,
  FLOAT: 0x1406,
  UNSIGNED_INT: 0x1405,
  INT: 0x1404,
} as const

function harness(): {
  device: WebGl2Device
  texImage: TexImageCall[]
  texSubImage: TexSubImageCall[]
} {
  const texImage: TexImageCall[] = []
  const texSubImage: TexSubImageCall[] = []
  const gl = {
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    deleteTexture: () => {},
    texImage2D: (
      _t: number,
      _l: number,
      internalFormat: number,
      _w: number,
      _h: number,
      _b: number,
      format: number,
      type: number,
    ) => {
      texImage.push({ internalFormat, format, type })
    },
    texSubImage2D: (
      _t: number,
      _l: number,
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      format: number,
      type: number,
      data: ArrayBufferView | null,
    ) => {
      texSubImage.push({ format, type, data })
    },
    TEXTURE_2D: 0x0de1,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    ...E,
  } as unknown as WebGL2RenderingContext
  return { device: new WebGl2Device(gl), texImage, texSubImage }
}

describe('storage data texture — the element picks the GL format (#1703)', () => {
  it('defaults to R32F, so every pre-#1703 caller allocates exactly what it always did', () => {
    const { device, texImage } = harness()
    device.createBuffer({ size: 16, usage: 'storage' })
    expect(texImage).toEqual([{ internalFormat: E.R32F, format: E.RED, type: E.FLOAT }])
  })

  it('elem u32 → R32UI / RED_INTEGER, the format a usampler2D requires', () => {
    const { device, texImage } = harness()
    device.createBuffer({ size: 16, usage: 'storage', elem: 'u32' })
    expect(texImage).toEqual([
      { internalFormat: E.R32UI, format: E.RED_INTEGER, type: E.UNSIGNED_INT },
    ])
  })

  it('elem i32 → R32I / RED_INTEGER, distinct from the unsigned one', () => {
    const { device, texImage } = harness()
    device.createBuffer({ size: 16, usage: 'storage', elem: 'i32' })
    expect(texImage).toEqual([{ internalFormat: E.R32I, format: E.RED_INTEGER, type: E.INT }])
  })

  it('the UPLOAD uses the matching typed array — WebGL2 rejects a mismatched one outright', () => {
    // texSubImage2D validates its typed array against `type`: a Uint32Array with gl.FLOAT
    // is an INVALID_OPERATION. So the view is built from the TEXTURE's element, never from
    // whatever the caller happened to pass — a u32 buffer written from a Uint32Array must
    // still upload as UNSIGNED_INT, and an f32 one as FLOAT.
    const { device, texSubImage } = harness()
    const f = device.createBuffer({ size: 16, usage: 'storage' })
    device.writeBuffer(f, 0, new Float32Array([1, 2, 3, 4]))
    const u = device.createBuffer({ size: 16, usage: 'storage', elem: 'u32' })
    device.writeBuffer(u, 0, new Uint32Array([1, 2, 3, 4]))
    const s = device.createBuffer({ size: 16, usage: 'storage', elem: 'i32' })
    device.writeBuffer(s, 0, new Int32Array([-1, -2, -3, -4]))

    expect(texSubImage.map((c) => [c.format, c.type, c.data?.constructor.name])).toEqual([
      [E.RED, E.FLOAT, 'Float32Array'],
      [E.RED_INTEGER, E.UNSIGNED_INT, 'Uint32Array'],
      [E.RED_INTEGER, E.INT, 'Int32Array'],
    ])
  })

  // The regression that shipped in #1703 and was caught by _1616-pan-points-gl2-gate
  // (0 red pixels where >2000 were expected). EVERY real caller passes a frame-arena
  // subarray — `FrameArena.allocF32` returns `new Float32Array(this.buffer, off, count)`
  // — so reading `data.buffer` from offset 0 uploads a neighbouring renderer's bytes.
  // Nothing errors; the draw just renders nothing.
  //
  // The tests above all pass WHOLE typed arrays (byteOffset 0), which is precisely why
  // they stayed green through the bug. A view with a NON-ZERO byteOffset is the case
  // that discriminates, so both paths — exact-fit and padded — are probed with one.
  describe('honours the caller VIEW window, not its backing buffer (#1703 regression)', () => {
    /** A `len`-word view sitting `offWords` into a larger arena, filled with `fill`;
     *  the arena around it holds a decoy value a buffer-start read would pick up. */
    const arenaView = (offWords: number, len: number, fill: number) => {
      const arena = new Float32Array(offWords + len + 8).fill(-999) // the decoy
      const view = new Float32Array(arena.buffer, offWords * 4, len)
      for (let i = 0; i < len; i++) view[i] = fill + i
      return view
    }

    it('an EXACT-FIT view uploads its own window', () => {
      const { device, texSubImage } = harness()
      const buf = device.createBuffer({ size: 16, usage: 'storage' }) // 4 texels
      device.writeBuffer(buf, 0, arenaView(7, 4, 100))
      const out = texSubImage.at(-1)!.data as Float32Array
      expect([...out.subarray(0, 4)]).toEqual([100, 101, 102, 103])
      expect([...out]).not.toContain(-999) // the arena decoy never reaches the GPU
    })

    it('a PADDED view copies from its own window too', () => {
      const { device, texSubImage } = harness()
      const buf = device.createBuffer({ size: 64, usage: 'storage' }) // 16 texels
      device.writeBuffer(buf, 0, arenaView(5, 4, 200))
      const out = texSubImage.at(-1)!.data as Float32Array
      expect(out.length).toBe(16)
      expect([...out.subarray(0, 4)]).toEqual([200, 201, 202, 203])
      expect([...out.subarray(4)]).toEqual(Array(12).fill(0))
    })
  })

  it('a PARTIAL write pads through the shared scratch and keeps the exact integer bits', () => {
    // The pad/copy runs on a Uint32Array word view for every element, so this is the test
    // that the byte move does not reinterpret anything. 0x00000001 and 0xFFFFFFFF are the
    // patterns a float round-trip is permitted to damage (denormal / NaN payload) — if the
    // padding ever went through a Float32Array they would be the first to move.
    const { device, texSubImage } = harness()
    const u = device.createBuffer({ size: 64, usage: 'storage', elem: 'u32' }) // 16 texels
    device.writeBuffer(u, 0, new Uint32Array([0x00000001, 0xffffffff, 0x007fffff, 0xdeadbeef]))
    const call = texSubImage.at(-1)!
    expect(call.type).toBe(E.UNSIGNED_INT)
    const out = call.data as Uint32Array
    expect(out).toBeInstanceOf(Uint32Array)
    expect(out.length).toBe(16) // padded to the full W×H
    expect([...out.subarray(0, 4)]).toEqual([0x00000001, 0xffffffff, 0x007fffff, 0xdeadbeef])
    expect([...out.subarray(4)]).toEqual(Array(12).fill(0)) // the tail reads 0 past the array
  })
})

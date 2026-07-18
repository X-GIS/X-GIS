// ═══ WebGl2Device r16float texture-format mapping (owned by rhi-webgl2) ═══
//
// Pins WebGl2Device.createTexture('r16float', sample+copy-dst) → R16F / RED / HALF_FLOAT
// and writeTexture's half-float upload — an invariant OWNED by this backend (it lives
// beside the other fake-gl suites so a texFmt regression fails in the rhi shard that
// owns it, not the map shard that merely consumes it). First exercised by the #1158
// coverage arm — the first SAMPLED half-float texture on the WebGL2 path (existing
// r16float uses were WebGPU-only render targets), so the RHI plumbing was unexercised.

import { describe, it, expect } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

interface Call {
  fn: string
  args: unknown[]
}
function fakeGl(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = []
  const rec =
    (fn: string) =>
    (...args: unknown[]): void => {
      calls.push({ fn, args })
    }
  const gl = {
    // format enums the texFmt path reads
    R16F: 0x822d,
    RED: 0x1903,
    HALF_FLOAT: 0x140b,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    // texture-object enums
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    NO_ERROR: 0,
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    createTexture: () => ({}),
    bindTexture: rec('bindTexture'),
    texImage2D: rec('texImage2D'),
    texSubImage2D: rec('texSubImage2D'),
    texParameteri: rec('texParameteri'),
    pixelStorei: rec('pixelStorei'),
    createSampler: () => ({}),
    samplerParameteri: rec('samplerParameteri'),
    getSupportedExtensions: () => [],
    getError: () => 0,
  } as unknown as WebGL2RenderingContext
  return { gl, calls }
}

describe('WebGl2Device r16float sample path (coverage arm)', () => {
  it('createTexture(r16float, sample+copy-dst) maps to R16F / RED / HALF_FLOAT', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    expect(dev.backend).toBe('webgl2')

    const tex = dev.createTexture({
      width: 4,
      height: 2,
      format: 'r16float',
      usage: ['sample', 'copy-dst'],
    })
    expect(tex).toBeTruthy()
    const img = calls.find((c) => c.fn === 'texImage2D')!
    // texImage2D(TEXTURE_2D, 0, internal, w, h, 0, format, type, null)
    expect(img.args[2]).toBe(0x822d) // R16F internal
    expect(img.args[6]).toBe(0x1903) // RED format
    expect(img.args[7]).toBe(0x140b) // HALF_FLOAT type
  })

  it('writeTexture uploads half-float data as RED / HALF_FLOAT texels', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    const tex = dev.createTexture({
      width: 4,
      height: 2,
      format: 'r16float',
      usage: ['sample', 'copy-dst'],
    })
    const half = new Uint16Array([0, 0x3c00, 0x3800, 0x3400, 0, 0x3c00, 0x3800, 0x3400])
    dev.writeTexture(tex, half, 4 * 2, 4, 2)
    const sub = calls.find((c) => c.fn === 'texSubImage2D')!
    expect(sub.args[6]).toBe(0x1903) // RED
    expect(sub.args[7]).toBe(0x140b) // HALF_FLOAT
    expect(sub.args[8]).toBe(half) // the exact half-float buffer
  })

  it('createView + a linear sampler for the coverage textures succeed', () => {
    const { gl } = fakeGl()
    const dev = new WebGl2Device(gl)
    const tex = dev.createTexture({
      width: 4,
      height: 2,
      format: 'r16float',
      usage: ['sample', 'copy-dst'],
    })
    expect(dev.createView(tex)).toBeTruthy()
    expect(dev.createSampler({ mag: 'linear', min: 'linear' })).toBeTruthy()
  })
})

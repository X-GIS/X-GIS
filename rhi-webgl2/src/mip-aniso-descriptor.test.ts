// ═══ mip + anisotropy reach the GL objects, and degrade OBSERVABLY (#1436) ═══
//
// The engine sampled every texture from a single mip level with a box-linear filter — the
// textbook under-sampling case, where a screen pixel covering many texels averages exactly 4 of
// them and picks a different 4 next frame. That is the shimmer on a pitched basemap.
//
// The blocker was that the RHI had no VOCABULARY for it: `RhiTextureDesc` had no
// `mipLevelCount`, `RhiSamplerDesc` had no mipmap filter and no `maxAnisotropy`, so no call site
// could ask however much it wanted to. These tests pin the widening at the seam where it is
// easiest to get silently wrong.
//
// Two properties matter more than "the field exists":
//
//   1. ADDITIVITY. A descriptor that predates #1436 must produce the byte-identical GL state it
//      did before. GL folds "filter within a level" and "blend between levels" into ONE
//      TEXTURE_MIN_FILTER enum, so widening it is exactly where an accidental behaviour change
//      for every existing sampler would hide.
//   2. The degrade is OBSERVABLE. Anisotropy is an EXTENSION on WebGL2 (WebGPU has it natively).
//      Absent, the sampler must fall back to plain trilinear rather than throw — and a caller
//      must be able to READ that it got nothing, rather than infer it from the platform.
//
// Driven through real WebGl2Device calls against a bare fake context, so they pin the code path
// rather than restate the rule.

import { describe, expect, it } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

const GL = {
  TEXTURE_2D: 0x0de1,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  UNSIGNED_BYTE: 0x1401,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_MAX_LEVEL: 0x813d,
  CLAMP_TO_EDGE: 0x812f,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
} as const

interface Recorded {
  samplerI: Array<[number, number]>
  samplerF: Array<[number, number]>
  texImage: Array<{ level: number; width: number; height: number }>
  texParamI: Array<[number, number]>
  mipmapCalls: number
}

/** A fake GL context recording the calls the assertions read back.
 *  `aniso` chooses whether the driver exposes EXT_texture_filter_anisotropic. */
function device(opts: { aniso: number | null } = { aniso: 16 }): {
  dev: WebGl2Device
  rec: Recorded
} {
  const rec: Recorded = {
    samplerI: [],
    samplerF: [],
    texImage: [],
    texParamI: [],
    mipmapCalls: 0,
  }
  const gl = {
    ...GL,
    createTexture: () => ({}),
    bindTexture: () => {},
    texImage2D: (_t: number, level: number, _i: number, width: number, height: number): void =>
      void rec.texImage.push({ level, width, height }),
    texSubImage2D: () => {},
    texParameteri: (_t: number, p: number, v: number): void => void rec.texParamI.push([p, v]),
    pixelStorei: () => {},
    texStorage2D: () => {},
    generateMipmap: (): void => void rec.mipmapCalls++,
    createSampler: () => ({}),
    samplerParameteri: (_s: unknown, p: number, v: number): void => void rec.samplerI.push([p, v]),
    samplerParameterf: (_s: unknown, p: number, v: number): void => void rec.samplerF.push([p, v]),
    getSupportedExtensions: () => (opts.aniso !== null ? ['EXT_texture_filter_anisotropic'] : []),
    getExtension: (name: string) =>
      name === 'EXT_texture_filter_anisotropic' && opts.aniso !== null
        ? {
            TEXTURE_MAX_ANISOTROPY_EXT: GL.TEXTURE_MAX_ANISOTROPY_EXT,
            MAX_TEXTURE_MAX_ANISOTROPY_EXT: GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
          }
        : null,
    getParameter: (p: number) => (p === GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT ? (opts.aniso ?? 1) : 0),
  } as unknown as WebGL2RenderingContext
  return { dev: new WebGl2Device(gl), rec }
}

const minFilter = (rec: Recorded): number | undefined =>
  rec.samplerI.find(([p]) => p === GL.TEXTURE_MIN_FILTER)?.[1]

describe('mip + anisotropy descriptors reach the GL objects (#1436)', () => {
  it('a pre-#1436 sampler is byte-identical — omitting `mipmap` keeps the single-level enums', () => {
    // THE ADDITIVITY PROPERTY. Every existing call site passes {mag, min} and nothing else; if
    // widening TEXTURE_MIN_FILTER changed what those produce, this feature would silently alter
    // the filtering of every texture in the engine while claiming to be opt-in.
    const { dev, rec } = device()
    dev.createSampler({ mag: 'linear', min: 'linear' })
    expect(minFilter(rec), 'linear/linear with no mipmap ⇒ plain LINEAR').toBe(GL.LINEAR)

    const b = device()
    b.dev.createSampler({ mag: 'nearest', min: 'nearest' })
    expect(minFilter(b.rec), 'nearest/nearest with no mipmap ⇒ plain NEAREST').toBe(GL.NEAREST)
  })

  it('(min × mipmap) selects the matching GL enum — all four combinations', () => {
    // GL folds two independent decisions into one enum, so this is the whole truth table rather
    // than a spot check: a transposed pair here is a plausible-looking filter that is wrong in
    // exactly the minification regime the feature exists to fix.
    const cases = [
      { min: 'linear', mipmap: 'linear', want: GL.LINEAR_MIPMAP_LINEAR, name: 'trilinear' },
      { min: 'linear', mipmap: 'nearest', want: GL.LINEAR_MIPMAP_NEAREST, name: 'bilinear+jump' },
      { min: 'nearest', mipmap: 'linear', want: GL.NEAREST_MIPMAP_LINEAR, name: 'point+blend' },
      { min: 'nearest', mipmap: 'nearest', want: GL.NEAREST_MIPMAP_NEAREST, name: 'point+jump' },
    ] as const
    for (const c of cases) {
      const { dev, rec } = device()
      dev.createSampler({ mag: 'linear', min: c.min, mipmap: c.mipmap })
      expect(minFilter(rec), `${c.name} (min=${c.min}, mipmap=${c.mipmap})`).toBe(c.want)
    }
  })

  it('anisotropy is clamped to the DRIVER ceiling, not the caller wish', () => {
    const { dev, rec } = device({ aniso: 4 })
    dev.createSampler({ mag: 'linear', min: 'linear', mipmap: 'linear', maxAnisotropy: 16 })
    expect(rec.samplerF).toEqual([[GL.TEXTURE_MAX_ANISOTROPY_EXT, 4]])
    expect(dev.maxAnisotropy, 'and the ceiling is readable').toBe(4)
  })

  it('without the extension it DEGRADES to trilinear, and the degrade is readable', () => {
    // The half that would otherwise be silent: no throw, no aniso parameter, and — the part that
    // makes it observable — `maxAnisotropy` reports 1, so a caller can tell "I asked and got
    // nothing" from "I asked and got it" without inferring from the platform.
    const { dev, rec } = device({ aniso: null })
    expect(() =>
      dev.createSampler({ mag: 'linear', min: 'linear', mipmap: 'linear', maxAnisotropy: 16 }),
    ).not.toThrow()
    expect(rec.samplerF, 'no aniso parameter was set').toEqual([])
    expect(minFilter(rec), 'still trilinear — the mip half is unaffected').toBe(
      GL.LINEAR_MIPMAP_LINEAR,
    )
    expect(dev.maxAnisotropy, '1 means asking bought nothing').toBe(1)
  })

  it('a mip chain allocates every level and caps TEXTURE_MAX_LEVEL', () => {
    // Without the extra levels the texture is mip-INCOMPLETE and GL samples it as if the chain
    // were not there — the feature would appear to do nothing for a reason no assertion on the
    // sampler alone could see.
    const { dev, rec } = device()
    dev.createTexture({
      width: 8,
      height: 8,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
      mipLevelCount: 4,
    })
    expect(rec.texImage.map((t) => [t.level, t.width, t.height])).toEqual([
      [0, 8, 8],
      [1, 4, 4],
      [2, 2, 2],
      [3, 1, 1],
    ])
    expect(rec.texParamI).toContainEqual([GL.TEXTURE_MAX_LEVEL, 3])
  })

  it('a single-level texture allocates exactly one level and sets no MAX_LEVEL', () => {
    const { dev, rec } = device()
    dev.createTexture({
      width: 8,
      height: 8,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
    })
    expect(rec.texImage).toEqual([{ level: 0, width: 8, height: 8 }])
    expect(rec.texParamI.some(([p]) => p === GL.TEXTURE_MAX_LEVEL)).toBe(false)
  })

  it('generateMipmaps delegates to gl.generateMipmap', () => {
    const { dev, rec } = device()
    const tex = dev.createTexture({
      width: 8,
      height: 8,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
      mipLevelCount: 4,
    })
    dev.generateMipmaps(tex)
    expect(rec.mipmapCalls).toBe(1)
  })
})

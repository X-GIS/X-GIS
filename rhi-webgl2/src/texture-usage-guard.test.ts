// ═══ The software backend enforces WebGPU's usage contract (#1419) ═══
//
// WebGPU validates every queue write against the target texture's usage flags. WebGL2 validates
// nothing — the same `writeTexture` simply works. That asymmetry is not a curiosity: it means a
// texture created without `copy-dst` passes every headless render gate in this repo (they all
// drive SwiftShader) and dies at boot on WebGPU.
//
// It cost the S-111 advected arrow field exactly that. `ArrowAdvectState` created its ping-pong
// pair with ['render','sample'] and seeded it with writeTexture; on WebGPU the whole portrayal
// was gone —
//
//   Usage (TextureBinding|RenderAttachment) of [Texture "arrow-advect-a"]
//   doesn't include TextureUsage::CopyDst — while calling Queue.WriteTexture
//
// — and the render gate that had just caught two OTHER breaks in that same feature was blind to
// it by construction. There is no WebGPU software adapter here to run a gate against, so the
// fix is the other direction: make the backend we CAN run enforce the stricter contract, in dev.
//
// These tests drive the guard through real WebGl2Device calls against a bare fake context, so
// they pin the actual code path rather than a restatement of the rule.

import { describe, expect, it } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

/** Enough of a GL context for createTexture + texSubImage2D to run. */
function device(): WebGl2Device {
  const gl = {
    createTexture: () => ({}),
    bindTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texStorage2D: () => {},
    createSampler: () => ({}),
    samplerParameteri: () => {},
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
  }
  return new WebGl2Device(gl as unknown as WebGL2RenderingContext)
}

const desc = (
  usage: ReadonlyArray<'sample' | 'render' | 'copy-dst' | 'copy-src'>,
  label: string,
) => ({ width: 4, height: 4, format: 'rgba8unorm' as const, usage, label })

describe('WebGl2Device texture-usage guard (#1419)', () => {
  it('writeTexture on a texture WITHOUT copy-dst fails loud, naming the texture', () => {
    // The exact shape of the shipped bug: a render target that is also seeded from the CPU.
    const d = device()
    const tex = d.createTexture(desc(['render', 'sample'], 'arrow-advect-a'))
    expect(() => d.writeTexture(tex, new Uint8Array(64), 16, 4, 4)).toThrow(
      /arrow-advect-a.*copy-dst/s,
    )
  })

  it('copyExternalImage is guarded too — it is a queue write by another name', () => {
    const d = device()
    const tex = d.createTexture(desc(['sample'], 'atlas-page'))
    expect(() => d.copyExternalImage(tex, {} as unknown as ImageBitmap, 4, 4)).toThrow(
      /atlas-page.*copy-dst/s,
    )
  })

  it('a correctly-declared texture writes without complaint', () => {
    // The guard must not fire on the ~15 textures in this repo that already declare it, or it
    // would be reverted within a day rather than kept.
    const d = device()
    const tex = d.createTexture(desc(['render', 'sample', 'copy-dst'], 'arrow-advect-a'))
    expect(() => d.writeTexture(tex, new Uint8Array(64), 16, 4, 4)).not.toThrow()
  })

  it('says WHY it fired — the failure has to teach the asymmetry, not just refuse', () => {
    const d = device()
    const tex = d.createTexture(desc(['render'], 'some-target'))
    let msg = ''
    try {
      d.writeTexture(tex, new Uint8Array(64), 16, 4, 4)
    } catch (e) {
      msg = String(e)
    }
    expect(msg).toMatch(/WebGPU requires/)
    expect(msg, 'names what the texture actually declared').toMatch(/\[render\]/)
    expect(msg, 'and that WebGL2 would not have caught it').toMatch(/WebGL2 does not check/)
  })
})

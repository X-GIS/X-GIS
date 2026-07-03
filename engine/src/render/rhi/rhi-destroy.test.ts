// ═══ RHI create/destroy symmetry (#782) ═══
//
// The RHI had `create*` ×7 but a single `destroyBuffer` — a texture / sampler /
// pipeline created through the RHI had NO RHI-level free (WebGL2 gl.delete* leak;
// WebGPU forces reaching behind the opaque handle). #782 adds destroyTexture /
// destroySampler / destroyPipeline. This gate proves each one actually releases the
// underlying resource (mirroring the arena double-free guard's behavioral style):
//
//  • WebGL2: a full create→destroy round trip asserts the SAME GL object the create
//    returned is handed to gl.deleteTexture / gl.deleteSampler / gl.deleteProgram.
//  • WebGPU: destroyTexture calls the native GPUTexture.destroy(); destroySampler /
//    destroyPipeline are no-ops (GPUSampler / GPURenderPipeline are GC-owned, no
//    native destroy) — asserted to NOT reach behind the handle and call destroy.

import { describe, it, expect } from 'vitest'
import { WebGpuDevice } from './rhi-webgpu'
import { WebGl2Device } from './rhi-webgl2'
import type { RhiTexture, RhiSampler, RhiPipeline } from './rhi'

// A fake WebGL2 context supporting the create + destroy paths of texture / sampler /
// pipeline. Every create* returns a UNIQUE sentinel so a round-trip test can assert
// the exact object flows into the matching delete*. `deleted` records each delete.
function fakeGl(): { gl: WebGL2RenderingContext; deleted: { textures: unknown[]; samplers: unknown[]; programs: unknown[] } } {
  const deleted = { textures: [] as unknown[], samplers: [] as unknown[], programs: [] as unknown[] }
  const gl = {
    // enum constants the create/reflect paths read (arbitrary distinct values)
    SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60, SAMPLER_3D: 0x8b5f, SAMPLER_2D_ARRAY: 0x8dc1,
    TEXTURE_2D: 0x0de1, RGBA8: 0x8058, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, ACTIVE_UNIFORM_BLOCKS: 0x8a36, ACTIVE_UNIFORMS: 0x8b86,
    // texture create/destroy
    createTexture: () => ({ id: 'tex' }),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    deleteTexture: (t: unknown) => { deleted.textures.push(t) },
    // sampler create/destroy
    createSampler: () => ({ id: 'samp' }),
    samplerParameteri: () => {},
    deleteSampler: (s: unknown) => { deleted.samplers.push(s) },
    // pipeline (program) create/destroy
    createShader: () => ({ id: 'shader' }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({ id: 'program' }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: (_p: unknown, pname: number) => (pname === 0x8b82 ? true : 0), // LINK_STATUS → true; block/uniform counts → 0
    getProgramInfoLog: () => '',
    deleteShader: () => {},
    useProgram: () => {},
    getUniformBlockIndex: () => 0,
    uniformBlockBinding: () => {},
    getActiveUniform: () => null,
    getUniformLocation: () => null,
    uniform1i: () => {},
    deleteProgram: (p: unknown) => { deleted.programs.push(p) },
  } as unknown as WebGL2RenderingContext
  return { gl, deleted }
}

describe('RHI create/destroy symmetry — WebGL2 (#782)', () => {
  it('destroyTexture deletes the exact GL texture the create returned', () => {
    const { gl, deleted } = fakeGl()
    const dev = new WebGl2Device(gl)
    const tex = dev.createTexture({ width: 4, height: 4, format: 'rgba8unorm', usage: ['sample', 'copy-dst'] })
    dev.destroyTexture(tex)
    expect(deleted.textures).toHaveLength(1)
    expect(deleted.textures[0]).toEqual({ id: 'tex' })
  })

  it('destroySampler deletes the exact GL sampler the create returned', () => {
    const { gl, deleted } = fakeGl()
    const dev = new WebGl2Device(gl)
    const samp = dev.createSampler({ mag: 'linear', min: 'linear' })
    dev.destroySampler(samp)
    expect(deleted.samplers).toHaveLength(1)
    expect(deleted.samplers[0]).toEqual({ id: 'samp' })
  })

  it('destroyPipeline deletes the linked GL program (reclaims the leaked WebGLProgram)', () => {
    const { gl, deleted } = fakeGl()
    const dev = new WebGl2Device(gl)
    const pipe = dev.createPipeline({
      code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: '#version 300 es\nvoid main(){}', fsCode: '#version 300 es\nvoid main(){}',
      bindGroupLayouts: [], colorTargets: [{ format: 'rgba8unorm' }],
    })
    dev.destroyPipeline(pipe)
    expect(deleted.programs).toHaveLength(1)
    expect(deleted.programs[0]).toEqual({ id: 'program' })
  })
})

describe('RHI create/destroy symmetry — WebGPU (#782)', () => {
  it('destroyTexture calls the native GPUTexture.destroy()', () => {
    let destroyed = 0
    const dev = new WebGpuDevice({} as GPUDevice)
    const handle = { native: { destroy: () => { destroyed++ } } } as unknown as RhiTexture
    dev.destroyTexture(handle)
    expect(destroyed).toBe(1)
  })

  it('destroySampler is a no-op — a GPUSampler is GC-owned (must not reach behind the handle)', () => {
    let touched = 0
    const dev = new WebGpuDevice({} as GPUDevice)
    const handle = { native: { destroy: () => { touched++ } } } as unknown as RhiSampler
    expect(() => dev.destroySampler(handle)).not.toThrow()
    expect(touched).toBe(0)
  })

  it('destroyPipeline is a no-op — a GPURenderPipeline is GC-owned (must not reach behind the handle)', () => {
    let touched = 0
    const dev = new WebGpuDevice({} as GPUDevice)
    const handle = { native: { destroy: () => { touched++ } } } as unknown as RhiPipeline
    expect(() => dev.destroyPipeline(handle)).not.toThrow()
    expect(touched).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

// US-002 (WebGL2 live-render milestone, Story 2): the RHI owns the backbuffer
// screen-pass lifecycle so a frame can ORIGINATE on WebGL2. These are the
// GPU-free shape tests (the real-GPU render is the Story-4 e2e gate): a fake gl
// records the calls beginScreenPass / endScreenPass make, so the FBO-0 target +
// viewport + clear + error-drain semantics are pinned without a real context.

interface Call { fn: string; args: unknown[] }

function fakeGl(): { gl: WebGL2RenderingContext; calls: Call[]; errors: number[] } {
  const calls: Call[] = []
  const errors: number[] = [] // queue of gl.getError() returns (0 = NO_ERROR terminates)
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }) }
  const gl = {
    // constants (distinct non-zero so the device constructor's SAMPLER set is happy)
    FRAMEBUFFER: 0x8d40, SCISSOR_TEST: 0x0c11,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, NO_ERROR: 0,
    SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60, SAMPLER_3D: 0x8b5f, SAMPLER_2D_ARRAY: 0x8dc1,
    bindFramebuffer: rec('bindFramebuffer'),
    viewport: rec('viewport'),
    disable: rec('disable'),
    clearColor: rec('clearColor'),
    // The clear block unmasks stencil (#746) + depth (#778 P/#780) before glClear,
    // since glClear honors the write masks — the fake must stub them.
    stencilMask: rec('stencilMask'),
    clearStencil: rec('clearStencil'),
    depthMask: rec('depthMask'),
    clear: rec('clear'),
    flush: rec('flush'),
    getError(): number { return errors.length ? errors.shift()! : 0 },
  } as unknown as WebGL2RenderingContext
  return { gl, calls, errors }
}

describe('WebGl2Device screen-pass lifecycle (US-002)', () => {
  it('beginScreenPass targets FBO 0, sets the viewport, and clears when asked', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    dev.beginScreenPass({ width: 320, height: 200, clear: [0, 0, 0, 1] })

    const bind = calls.find((c) => c.fn === 'bindFramebuffer')!
    expect(bind.args[0]).toBe(0x8d40) // FRAMEBUFFER
    expect(bind.args[1]).toBeNull()   // FBO 0 = the default framebuffer the canvas presents
    expect(calls.find((c) => c.fn === 'viewport')!.args).toEqual([0, 0, 320, 200])
    expect(calls.find((c) => c.fn === 'clearColor')!.args).toEqual([0, 0, 0, 1])
    expect(calls.some((c) => c.fn === 'clear')).toBe(true)
  })

  it('beginScreenPass skips the clear when no clear colour is given (load semantics)', () => {
    const { gl, calls } = fakeGl()
    new WebGl2Device(gl).beginScreenPass({ width: 8, height: 8 })
    expect(calls.some((c) => c.fn === 'clearColor')).toBe(false)
    expect(calls.some((c) => c.fn === 'clear')).toBe(false)
  })

  it('endScreenPass flushes and drains gl.getError into the queue', () => {
    const { gl, calls, errors } = fakeGl()
    const dev = new WebGl2Device(gl)
    errors.push(0x0500, 0x0502) // INVALID_ENUM then INVALID_OPERATION, then NO_ERROR
    const pass = dev.beginScreenPass({ width: 8, height: 8 })
    dev.endScreenPass(pass)

    expect(calls.some((c) => c.fn === 'flush')).toBe(true)
    const drained = dev.takeGlErrors()
    expect(drained).toEqual(['gl.getError 0x500', 'gl.getError 0x502'])
    // takeGlErrors clears the queue
    expect(dev.takeGlErrors()).toEqual([])
  })

  it('a clean frame drains no errors', () => {
    const { gl } = fakeGl()
    const dev = new WebGl2Device(gl)
    dev.endScreenPass(dev.beginScreenPass({ width: 8, height: 8 }))
    expect(dev.takeGlErrors()).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { WebGl2Device, wrapWebGl2Pass } from './rhi-webgl2'
import type { RhiPipeline, RhiBuffer } from '@xgis/rhi'

// #1796 — WebGL2's per-attribute ENABLED state lives on the context-wide default VAO and
// outlives every pipeline switch. bindAttributes() used to only ever ENABLE locations; a
// pipeline with fewer (or zero, like the line pipeline) vertex attributes than the one
// drawn before it left the extra locations enabled with no buffer pointed at them, and
// drawArrays*/drawElements* on that state raises INVALID_OPERATION and the draw is DROPPED
// per spec. These are GPU-free shape tests: a fake gl records enable/disable calls so the
// reconcile-against-the-live-mask discipline is pinned without a real context.
//
// Follow-up (adversarial review): a fresh `attribState.mask = 0` only describes what THIS
// device has tracked — not what the adopted `gl` context really has enabled. gpu.ts's
// ensure-restored preamble hands a REMOUNT the SAME pooled context a prior (destroyed)
// device left dirty (rhi-webgl2/src/device-lifecycle.ts), with real attributes still
// enabled and their buffers already gone. The constructor now does a one-time reconcile
// (test (d) below); tests (a)-(c) isolate that construction-time noise out of their own
// `calls` recordings so they keep pinning per-draw behaviour only.

interface Call {
  fn: string
  args: unknown[]
}

const GL = {
  ARRAY_BUFFER: 0x8892,
  FLOAT: 0x1406,
  TRIANGLES: 0x0004,
  DEPTH_TEST: 0x0b71,
  POLYGON_OFFSET_FILL: 0x8037,
  CULL_FACE: 0x0b44,
  CCW: 0x0901,
  CW: 0x0900,
  STENCIL_TEST: 0x0b90,
  BLEND: 0x0be2,
  SAMPLER_2D: 0x8b5e,
  SAMPLER_CUBE: 0x8b60,
  SAMPLER_3D: 0x8b5f,
  SAMPLER_2D_ARRAY: 0x8dc1,
  MAX_VERTEX_ATTRIBS: 0x8869,
}

function fakeGl(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = []
  const rec =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args })
    }
  const gl = {
    ...GL,
    useProgram: rec('useProgram'),
    disable: rec('disable'),
    enable: rec('enable'),
    colorMask: rec('colorMask'),
    depthMask: rec('depthMask'),
    stencilMask: rec('stencilMask'),
    frontFace: rec('frontFace'),
    bindBuffer: rec('bindBuffer'),
    enableVertexAttribArray: rec('enableVertexAttribArray'),
    disableVertexAttribArray: rec('disableVertexAttribArray'),
    vertexAttribPointer: rec('vertexAttribPointer'),
    drawArrays: rec('drawArrays'),
  } as unknown as WebGL2RenderingContext
  return { gl, calls }
}

/** `fakeGl()` above deliberately answers no `gl.getParameter` — every OTHER test in this
 *  file exercises per-draw reconcile behaviour and must see zero calls from device
 *  CONSTRUCTION. This fixture is the one exception: it answers
 *  `gl.getParameter(MAX_VERTEX_ATTRIBS)`, simulating the ONE capability a fresh
 *  `WebGl2Device` needs to reconcile a context it did not create — a REMOUNT over the
 *  SAME pooled context a prior (destroyed) device left with real attributes enabled
 *  (device-lifecycle.ts). `disableVertexAttribArray` is already recorded by the base
 *  fixture, so this is the only capability that needs adding. */
function fakeGlPooled(maxVertexAttribs: number): { gl: WebGL2RenderingContext; calls: Call[] } {
  const { gl, calls } = fakeGl()
  const pooled = {
    ...gl,
    getParameter: (p: number) => (p === GL.MAX_VERTEX_ATTRIBS ? maxVertexAttribs : 0),
  } as unknown as WebGL2RenderingContext
  return { gl: pooled, calls }
}

/** A pipeline whose `vertexBuffers` declares one attribute per given location — mirrors
 *  `Gl2Pipeline`'s shape closely enough for `setPipeline`/`bindAttributes` (both reach
 *  their fields via an opaque cast, never a real RHI-side validation). Empty `locations`
 *  reproduces the line pipeline (map/src/render/material/line-material.ts): a DrawItem
 *  with no vertex buffer at all. */
function pipelineWithLocations(locations: number[]): RhiPipeline {
  return {
    program: {},
    blend: undefined,
    colorWriteMask: [true, true, true, true],
    frontFace: 'ccw',
    vertexBuffers: locations.length
      ? [
          {
            stride: 4,
            attributes: locations.map((location) => ({ location, offset: 0, format: 'float32' })),
          },
        ]
      : [],
    layouts: [],
  } as unknown as RhiPipeline
}

const fakeVbuf = { buf: {} } as unknown as RhiBuffer

function enableDisableCalls(calls: Call[]): Call[] {
  return calls.filter(
    (c) => c.fn === 'enableVertexAttribArray' || c.fn === 'disableVertexAttribArray',
  )
}

describe('WebGl2RenderPass vertex-attrib enable/disable discipline (#1796)', () => {
  it('disables every attribute the prior pipeline left enabled when the next pipeline declares none (fail-before: nothing ever disabled)', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    // Isolate away the constructor's own one-time pooled-context reset (test (d) below) —
    // this test pins PER-DRAW reconcile behaviour only.
    calls.length = 0
    const pass = wrapWebGl2Pass(dev)

    pass.setPipeline(pipelineWithLocations([0, 1]))
    pass.setVertexBuffer(0, fakeVbuf)
    pass.draw(6)

    // The line pipeline: no vertexBuffers, no setVertexBuffer call — exactly #1796's shape.
    pass.setPipeline(pipelineWithLocations([]))
    pass.draw(6)

    const disabled = calls
      .filter((c) => c.fn === 'disableVertexAttribArray')
      .map((c) => c.args[0])
    expect(disabled.sort((a, b) => (a as number) - (b as number))).toEqual([0, 1])

    // The disables must land before the SECOND drawArrays — a location still enabled at
    // that draw with no buffer bound to it is the exact INVALID_OPERATION the issue reports.
    const drawIdxs = calls.map((c, i) => ({ i, fn: c.fn })).filter((c) => c.fn === 'drawArrays')
    expect(drawIdxs).toHaveLength(2)
    const secondDrawIdx = drawIdxs[1].i
    const lastDisableIdx = Math.max(
      ...calls.map((c, i) => (c.fn === 'disableVertexAttribArray' ? i : -1)),
    )
    expect(lastDisableIdx).toBeLessThan(secondDrawIdx)
  })

  it('switching between pipelines with overlapping attribute sets touches only the difference', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    const pass = wrapWebGl2Pass(dev)

    pass.setPipeline(pipelineWithLocations([0, 1]))
    pass.setVertexBuffer(0, fakeVbuf)
    pass.draw(6)
    calls.length = 0 // isolate the SWITCH

    pass.setPipeline(pipelineWithLocations([1, 2]))
    pass.setVertexBuffer(0, fakeVbuf)
    pass.draw(6)

    const disabled = calls.filter((c) => c.fn === 'disableVertexAttribArray').map((c) => c.args[0])
    const enabled = calls.filter((c) => c.fn === 'enableVertexAttribArray').map((c) => c.args[0])
    // location 0 leaves, location 2 arrives; location 1 (the intersection) is churn-free.
    expect(disabled).toEqual([0])
    expect(enabled).toEqual([2])
  })

  it('consecutive draws with the same pipeline issue no enable/disable calls', () => {
    const { gl, calls } = fakeGl()
    const dev = new WebGl2Device(gl)
    calls.length = 0 // isolate away the constructor's own one-time pooled-context reset
    const pass = wrapWebGl2Pass(dev)
    const pl = pipelineWithLocations([0, 1])

    pass.setPipeline(pl)
    pass.setVertexBuffer(0, fakeVbuf)
    pass.draw(6)
    const afterFirst = enableDisableCalls(calls).length
    expect(afterFirst).toBe(2) // enable(0), enable(1)

    pass.draw(6) // same pipeline, same buffer — nothing about the enabled set changed
    expect(enableDisableCalls(calls).length).toBe(afterFirst)
  })

  it('a device adopting a pooled/dirty context disables the real enabled set at construction, before the first draw (#1796 follow-up)', () => {
    // Simulates gpu.ts's ensure-restored preamble handing a REMOUNT the SAME pooled
    // context a prior (destroyed) device left dirty (device-lifecycle.ts): this fixture
    // answers gl.getParameter(MAX_VERTEX_ATTRIBS) — the ONE query the constructor needs to
    // reconcile a context it did not create, but no test above needed.
    const { gl, calls } = fakeGlPooled(16)

    const dev = new WebGl2Device(gl)

    // FAIL-BEFORE (commit d50b7909): the constructor never called disableVertexAttribArray
    // at all — a remount's fresh mask=0 was trusted at face value instead of reconciled
    // against the adopted context, so this array was always `[]` and the assertion below
    // failed. It is the constructor call above, not any draw, that must produce these.
    const disabledAtConstruction = calls
      .filter((c) => c.fn === 'disableVertexAttribArray')
      .map((c) => c.args[0])
    expect(disabledAtConstruction).toEqual(Array.from({ length: 16 }, (_, i) => i))

    // The reconcile already ran — strictly before any draw exists to run one. A
    // zero-attribute (line-pipeline-shaped) draw right after must find nothing left to
    // disable: the pooled context is already clean by the time this draw's bindAttributes
    // runs, so it is exactly the INVALID_OPERATION-triggering gap that no longer exists.
    calls.length = 0
    const pass = wrapWebGl2Pass(dev)
    pass.setPipeline(pipelineWithLocations([]))
    pass.draw(6)
    expect(calls.filter((c) => c.fn === 'disableVertexAttribArray')).toHaveLength(0)
  })
})

import { describe, it, expect } from 'vitest'
import { WebGl2Device, wrapWebGl2Pass } from './rhi-webgl2'
import type { RhiPipeline, RhiBuffer } from '@xgis/rhi'

// #2360 — `setVertexBuffer(slot, ...)` is a PER-SLOT binding in the RHI contract
// (rhi/src/rhi.ts) and WebGPU honours it natively. The WebGL2 pass stored the buffer in a
// single scalar field and discarded `slot`, so a second slot's bind overwrote the first;
// `bindAttributes` then bound that one buffer once and pointed EVERY declared slot's
// attributes at it, each at its own stride/offset. Slot 0's attributes were read out of
// slot 1's memory — silent geometry corruption on WebGL2 while the same draw is correct on
// WebGPU.
//
// These are GPU-free shape tests in the idiom of webgl2-attrib-enable-discipline.test.ts: a
// fake gl records the calls, so what is pinned is the BINDING DISCIPLINE, not pixels.

interface Call {
  fn: string
  args: unknown[]
}

const GL = {
  ARRAY_BUFFER: 0x8892,
  FLOAT: 0x1406,
  UNSIGNED_INT: 0x1405,
  TRIANGLES: 0x0004,
  DEPTH_TEST: 0x0b71,
  POLYGON_OFFSET_FILL: 0x8037,
  CULL_FACE: 0x0b44,
  CCW: 0x0901,
  CW: 0x0900,
  STENCIL_TEST: 0x0b90,
  BLEND: 0x0be2,
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
    vertexAttribIPointer: rec('vertexAttribIPointer'),
    drawArrays: rec('drawArrays'),
  } as unknown as WebGL2RenderingContext
  return { gl, calls }
}

/** A pipeline declaring one vertex-buffer slot per entry, each with a single float
 *  attribute at the given location and its own stride — distinct strides let an assertion
 *  tell WHICH slot's layout a pointer call used. */
function pipelineWithSlots(slots: { location: number; stride: number }[]): RhiPipeline {
  return {
    program: {},
    blend: undefined,
    colorWriteMask: [true, true, true, true],
    frontFace: 'ccw',
    vertexBuffers: slots.map((s) => ({
      stride: s.stride,
      attributes: [{ location: s.location, offset: 0, format: 'float32' }],
    })),
    layouts: [],
  } as unknown as RhiPipeline
}

const bufA = { buf: 'A' } as unknown as RhiBuffer
const bufB = { buf: 'B' } as unknown as RhiBuffer

function newPass(gl: WebGL2RenderingContext) {
  return wrapWebGl2Pass(new WebGl2Device(gl))
}

describe('#2360 · WebGl2RenderPass vertex-buffer slots', () => {
  it('binds each declared slot to ITS OWN buffer, not all of them to the last one', () => {
    const { gl, calls } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(
      pipelineWithSlots([
        { location: 0, stride: 4 },
        { location: 1, stride: 16 },
      ]),
    )
    pass.setVertexBuffer(0, bufA)
    pass.setVertexBuffer(1, bufB)
    pass.draw(6)

    const bound = calls.filter((c) => c.fn === 'bindBuffer').map((c) => c.args[1] as string)
    // Pre-fix this was ['B'] — one bind, and bufA's binding silently overwritten.
    expect(bound).toEqual(['A', 'B'])
  })

  it("points each slot's attribute at that slot's buffer with that slot's stride", () => {
    const { gl, calls } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(
      pipelineWithSlots([
        { location: 0, stride: 4 },
        { location: 1, stride: 16 },
      ]),
    )
    pass.setVertexBuffer(0, bufA)
    pass.setVertexBuffer(1, bufB)
    pass.draw(6)

    // Interleave the two call kinds so the ORDER is pinned, not just the multiset: a
    // pointer call is only correct relative to the bindBuffer that precedes it, and an
    // implementation that bound both buffers up front and then pointed everything would
    // satisfy a set-based assertion while still reading slot 0 out of bufB.
    const seq = calls
      .filter((c) => c.fn === 'bindBuffer' || c.fn === 'vertexAttribPointer')
      .map((c) =>
        c.fn === 'bindBuffer'
          ? `bind:${c.args[1] as string}`
          : `ptr:loc${c.args[0] as number}:stride${c.args[4] as number}`,
      )
    expect(seq).toEqual(['bind:A', 'ptr:loc0:stride4', 'bind:B', 'ptr:loc1:stride16'])
  })

  it("applies each slot's own byte offset, not slot 0's, to its attributes", () => {
    const { gl, calls } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(
      pipelineWithSlots([
        { location: 0, stride: 4 },
        { location: 1, stride: 16 },
      ]),
    )
    pass.setVertexBuffer(0, bufA, 100)
    pass.setVertexBuffer(1, bufB, 200)
    pass.draw(6)

    const offsets = calls
      .filter((c) => c.fn === 'vertexAttribPointer')
      .map((c) => c.args[5] as number)
    // Pre-fix BOTH were the last-written scalar offset (200).
    expect(offsets).toEqual([100, 200])
  })

  it('a single-slot draw is unchanged — one bind, slot 0, its own offset', () => {
    // The control that keeps this from being a rewrite: every caller in the tree today
    // binds slot 0 only, so that path must stay byte-identical.
    const { gl, calls } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(pipelineWithSlots([{ location: 3, stride: 8 }]))
    pass.setVertexBuffer(0, bufA, 64)
    pass.draw(3)

    const bound = calls.filter((c) => c.fn === 'bindBuffer').map((c) => c.args[1] as string)
    expect(bound).toEqual(['A'])
    const ptr = calls.filter((c) => c.fn === 'vertexAttribPointer')
    expect(ptr).toHaveLength(1)
    expect(ptr[0]!.args[0]).toBe(3)
    expect(ptr[0]!.args[4]).toBe(8)
    expect(ptr[0]!.args[5]).toBe(64)
  })

  it('throws, naming the slot, when the pipeline declares a slot nothing bound', () => {
    // The alternative is worse than a throw and is what the old code did on this input:
    // the enable mask covers slot 1's location, and an enabled location with no buffer
    // makes the draw raise INVALID_OPERATION and be DROPPED (the #1796 hazard this file's
    // sibling test pins). WebGPU validates the same requirement.
    const { gl } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(
      pipelineWithSlots([
        { location: 0, stride: 4 },
        { location: 1, stride: 16 },
      ]),
    )
    pass.setVertexBuffer(0, bufA)
    expect(() => pass.draw(6)).toThrow(/slot 1/)
  })

  it('a later draw does not inherit a stale slot-1 binding after the pipeline drops to one slot', () => {
    // Slot state is per pass and survives setPipeline, so a two-slot draw followed by a
    // one-slot draw must not keep binding B. Pins that the fix did not turn the scalar
    // into a leak with more slots.
    const { gl, calls } = fakeGl()
    const pass = newPass(gl)
    pass.setPipeline(
      pipelineWithSlots([
        { location: 0, stride: 4 },
        { location: 1, stride: 16 },
      ]),
    )
    pass.setVertexBuffer(0, bufA)
    pass.setVertexBuffer(1, bufB)
    pass.draw(6)
    const before = calls.length

    pass.setPipeline(pipelineWithSlots([{ location: 0, stride: 4 }]))
    pass.setVertexBuffer(0, bufA)
    pass.draw(3)

    const bound = calls
      .slice(before)
      .filter((c) => c.fn === 'bindBuffer')
      .map((c) => c.args[1] as string)
    expect(bound).toEqual(['A'])
  })
})

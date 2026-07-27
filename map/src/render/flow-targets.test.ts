import { describe, it, expect } from 'vitest'
import {
  FlowTargets,
  FLOW_MAX_DIM,
  FLOW_FIELD_FORMAT,
  FLOW_FIELD_FORMAT_FALLBACK,
  flowFieldFormat,
} from './flow-targets'

// IBFV ping-pong lifecycle (#1333). The gates pin the three ways this differs from the
// non-recursive HeatmapTargets it is modelled on — grid sizing, the ping-pong swap, and the
// clear obligation — because those are exactly where a recursive filter breaks differently.

interface StubTex {
  __id: number
  width: number
  height: number
  format: string
  usage: string[]
  label?: string
}

function makeRhi() {
  let id = 0
  const created: StubTex[] = []
  const destroyed: StubTex[] = []
  const rhi = {
    createTexture: (d: {
      width: number
      height: number
      format: string
      usage: string[]
      label?: string
    }) => {
      const t: StubTex = { __id: id++, ...d }
      created.push(t)
      return t
    },
    createView: (t: StubTex) => ({ __view: t.__id }),
    destroyTexture: (t: StubTex) => {
      destroyed.push(t)
    },
  }
  return { rhi, created, destroyed }
}

describe('FlowTargets — IBFV ping-pong pair (#1333)', () => {
  it('allocates a PAIR at the grid size, render+sample on both sides', () => {
    const ft = new FlowTargets()
    const { rhi, created } = makeRhi()
    ft.ensure(rhi as never, 596, 433, true)
    expect(created).toHaveLength(2)
    for (const t of created) {
      expect([t.width, t.height]).toEqual([596, 433])
      expect(t.format).toBe(FLOW_FIELD_FORMAT)
      // Both sides alternate roles every frame, so both need both usages.
      expect(t.usage).toEqual(expect.arrayContaining(['render', 'sample']))
    }
    expect(ft.size).toEqual({ width: 596, height: 433 })
  })

  it('THE FALLBACK GATE: no float render targets → the rgba8unorm floor, never a broken FBO', () => {
    // Rendering INTO a half-float attachment on WebGL2 needs EXT_color_buffer_float; without
    // it the FBO is INCOMPLETE and every draw raises GL_INVALID_FRAMEBUFFER_OPERATION. rgba8 is
    // core in both backends and needs no extension, so the flow layer degrades in precision
    // rather than failing to render.
    const ft = new FlowTargets()
    const { rhi, created } = makeRhi()
    ft.ensure(rhi as never, 8, 8, false)
    expect(created.every((t) => t.format === FLOW_FIELD_FORMAT_FALLBACK)).toBe(true)
    expect(ft.storageFormat).toBe(FLOW_FIELD_FORMAT_FALLBACK)
    // The default is the SAFE one: a caller that forgets the flag cannot land on the format
    // that needs an extension.
    const ft2 = new FlowTargets()
    const r2 = makeRhi()
    ft2.ensure(r2.rhi as never, 8, 8)
    expect(ft2.storageFormat).toBe(FLOW_FIELD_FORMAT_FALLBACK)
  })

  it('a capability CHANGE reallocates — the pair cannot keep a format the device lost', () => {
    // A device swap can land on hardware without the float extension; keeping the old
    // half-float pair would render into an attachment the new device cannot complete.
    const ft = new FlowTargets()
    const { rhi, created, destroyed } = makeRhi()
    ft.ensure(rhi as never, 8, 8, true)
    ft.markCleared()
    expect(ft.storageFormat).toBe(FLOW_FIELD_FORMAT)
    ft.ensure(rhi as never, 8, 8, false)
    expect(ft.storageFormat).toBe(FLOW_FIELD_FORMAT_FALLBACK)
    expect(destroyed).toHaveLength(2)
    expect(created).toHaveLength(4)
    // ...and the fresh pair is unclean, so the recursion restarts from a known state.
    expect(ft.needsClear).toBe(true)
  })

  it('flowFieldFormat is a pure predicate, so the choice is testable without a device', () => {
    expect(flowFieldFormat(true)).toBe(FLOW_FIELD_FORMAT)
    expect(flowFieldFormat(false)).toBe(FLOW_FIELD_FORMAT_FALLBACK)
  })

  it('swap() exchanges read and write — this frame’s output is next frame’s history', () => {
    const ft = new FlowTargets()
    const { rhi } = makeRhi()
    ft.ensure(rhi as never, 8, 8)
    const r0 = ft.readView
    const w0 = ft.writeView
    expect(r0).not.toEqual(w0) // never read and write the same texture in one step
    ft.swap()
    expect(ft.readView).toEqual(w0) // what we just wrote is now the history
    expect(ft.writeView).toEqual(r0)
    ft.swap()
    expect(ft.readView).toEqual(r0) // two swaps return to the start
  })

  it('THE CLEAR GATE: a fresh pair demands a clear, and a REallocation demands it again', () => {
    // A recursive filter feeds on its history: undefined texture contents would persist
    // indefinitely rather than being overwritten. This is the trap a non-recursive pass
    // (heatmap) does not have.
    const ft = new FlowTargets()
    const { rhi } = makeRhi()
    ft.ensure(rhi as never, 8, 8)
    expect(ft.needsClear).toBe(true)
    ft.markCleared()
    expect(ft.needsClear).toBe(false)
    // A no-op ensure must NOT re-arm it (that would clear the history every frame — the
    // animation would never accumulate).
    ft.ensure(rhi as never, 8, 8)
    expect(ft.needsClear).toBe(false)
    // ...but a real reallocation must.
    ft.ensure(rhi as never, 16, 16)
    expect(ft.needsClear).toBe(true)
  })

  it('is sized by the GRID, so a window resize is not a reason to reallocate', () => {
    // The history lives in the coverage raster precisely so it is camera-independent. If the
    // pair tracked canvas size, every resize would throw the animation away.
    const ft = new FlowTargets()
    const { rhi, created } = makeRhi()
    ft.ensure(rhi as never, 100, 50)
    ft.markCleared()
    const afterFirst = created.length
    // The pass would call ensure() again each frame with the SAME grid, whatever the window did.
    for (let i = 0; i < 5; i++) ft.ensure(rhi as never, 100, 50)
    expect(created).toHaveLength(afterFirst)
    expect(ft.needsClear).toBe(false)
  })

  it('caps either dimension at FLOW_MAX_DIM so a global grid cannot allocate unbounded', () => {
    const ft = new FlowTargets()
    const { rhi, created } = makeRhi()
    ft.ensure(rhi as never, 100_000, 40_000)
    expect(created[0]!.width).toBe(FLOW_MAX_DIM)
    expect(created[0]!.height).toBe(FLOW_MAX_DIM)
    // A degenerate grid still yields a usable 1×1 rather than a zero-sized texture.
    const ft2 = new FlowTargets()
    const r2 = makeRhi()
    ft2.ensure(r2.rhi as never, 0, 0)
    expect([r2.created[0]!.width, r2.created[0]!.height]).toEqual([1, 1])
  })

  it('a real resize destroys the old pair before allocating the new one (no leak)', () => {
    const ft = new FlowTargets()
    const { rhi, created, destroyed } = makeRhi()
    ft.ensure(rhi as never, 8, 8)
    const first = [...created]
    ft.ensure(rhi as never, 16, 16)
    expect(destroyed).toEqual(first)
    expect(created).toHaveLength(4)
  })

  it('a DEVICE swap drops the handles WITHOUT destroying through the dead device (#737)', () => {
    const ft = new FlowTargets()
    const one = makeRhi()
    ft.ensure(one.rhi as never, 8, 8)
    const two = makeRhi()
    ft.ensure(two.rhi as never, 8, 8)
    // Destroying a texture through the device that already died is the hazard; the old
    // textures are freed with their device.
    expect(one.destroyed).toHaveLength(0)
    expect(two.created).toHaveLength(2)
    // ...and the fresh pair is unclean again, so the recursion restarts from a known state.
    expect(ft.needsClear).toBe(true)
  })

  it('destroy() frees the pair and leaves the object reusable', () => {
    const ft = new FlowTargets()
    const { rhi, created, destroyed } = makeRhi()
    ft.ensure(rhi as never, 8, 8)
    ft.destroy()
    expect(destroyed).toHaveLength(2)
    expect(ft.readView).toBeNull()
    expect(ft.writeView).toBeNull()
    expect(ft.size).toEqual({ width: 0, height: 0 })
    // Idempotent — a second destroy must not double-free.
    ft.destroy()
    expect(destroyed).toHaveLength(2)
    // And it can be armed again (scene swap → new style with a flow layer).
    ft.ensure(rhi as never, 8, 8)
    expect(created).toHaveLength(4)
    expect(ft.needsClear).toBe(true)
  })
})

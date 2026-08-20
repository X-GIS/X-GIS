import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// #1888 — the retained drapers are built ON FIRST USE, and this is the gate that says so
// about the RUNNING manager rather than about its source.
//
// install.test.ts's census already reads `GraphicsManager`'s text and refuses to let the
// `FAMILY_GROUPS` rows disagree with where the constructors sit. That is a strong gate and it
// is not this one: a census cannot see a call path that reaches a constructor anyway. Move the
// `new RetainedIconDraper(...)` out of `attachDevice` and into a helper `attachDevice` calls on
// the next line, and the census goes green while every boot still builds all five.
//
// So this counts CONSTRUCTIONS, by mocking the five material modules. The assertion that
// carries the weight is the negative one — after a device attach, and after adding a batch of
// ONE kind, the other four must be at zero. A test that only checked "the circle draper exists
// once a circle is added" would pass identically on the eager code this replaced.

const built: string[] = []

/** Replace one draper class with a construction-recording stub. The manager only calls
 *  `makeBatchBindGroup` during materialise and `draw` during a frame, so a two-method stub is
 *  the whole surface these tests reach. */
function spy(name: string) {
  return class {
    constructor() {
      built.push(name)
    }
    makeBatchBindGroup() {
      return {}
    }
    draw() {
      return 0
    }
  }
}

vi.mock('../render/material/icon-retained-material', () => ({
  RetainedIconDraper: spy('icon'),
}))
vi.mock('../render/material/arrow-retained-material', () => ({
  RetainedArrowDraper: spy('arrow'),
}))
vi.mock('../render/material/arrow-retained-advected-material', () => ({
  RetainedArrowAdvectedDraper: spy('advected'),
}))
vi.mock('../render/material/circle-retained-material', () => ({
  RetainedCircleDraper: spy('circle'),
}))
vi.mock('../render/material/particle-retained-material', () => ({
  RetainedParticleDraper: spy('particle'),
}))

const { GraphicsManager } = await import('./graphics-manager')

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.GPUTextureUsage === undefined)
    g.GPUTextureUsage = {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    }
})

beforeEach(() => {
  built.length = 0
})

function makeStubs() {
  const rhi = {
    createBuffer: (d: { label?: string }) => ({ label: d.label }),
    writeBuffer: () => {},
    destroyBuffer: () => {},
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipeline: () => ({}),
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    writeTexture: () => {},
    caps: { shaderLanguage: 'wgsl' },
  }
  return { rhi, device: { queue: { writeBuffer: () => {} } } }
}

const attached = () => {
  const gm = new GraphicsManager()
  const s = makeStubs()
  gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
  return gm
}

const circleSpec = () => ({
  type: 'circle' as const,
  data: [{ lon: 1, lat: 2 }],
  getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat] as [number, number],
  getRadius: 6,
  getColor: () => [1, 0, 0, 1] as [number, number, number, number],
  getStrokeColor: () => [1, 1, 1, 1] as [number, number, number, number],
  getStrokeWidth: 1,
  updateTriggers: { color: 1 },
})

describe('retained drapers are built on first use, not at attach (#1888)', () => {
  it('attaching a device builds NONE of them', () => {
    // The whole change in one assertion: a map that never calls `map.graphics.*` reaches no
    // retained shader, so none of the five families has to ride in the boot artifact.
    attached()
    expect(built).toEqual([])
  })

  it('adding a circle builds the circle draper and ONLY the circle draper', () => {
    const gm = attached()
    gm.add(circleSpec())
    expect(built).toEqual(['circle'])
  })

  it('a second circle reuses the first draper (the slot memoises)', () => {
    // Without the memo this would build one per batch — the accessor would be lazy and also
    // wrong, and nothing above would notice.
    const gm = attached()
    gm.add(circleSpec())
    gm.add(circleSpec())
    expect(built).toEqual(['circle'])
  })

  it('the compiled-arrow store builds nothing until a layer arrives', () => {
    // `attachDevice` hands the store two THUNKS. Handing it drapers — the shape before #1888 —
    // would build the arrow pair for every map with a device, which is 42,410 of the 79,964
    // raw chars this change moved off the boot path.
    const gm = attached()
    expect(built).toEqual([])
    gm.addCompiledArrowLayer(
      Float64Array.from([-70, -69]),
      Float64Array.from([40, 41]),
      Float32Array.from([0, 90]),
      Float32Array.from([12, 12]),
      [
        [1, 0, 0, 1],
        [1, 0, 0, 1],
      ],
      0,
    )
    expect(built).toEqual(['arrow'])
  })

  it('a re-attach does not leave a draper bound to the previous device', () => {
    // The drapers hold their `rhi`, so a per-run re-attach has to clear the slots or the next
    // run draws through buffers the old device owned. Eager construction got this for free by
    // overwriting every slot; lazy construction has to say it.
    const gm = attached()
    gm.add(circleSpec())
    expect(built).toEqual(['circle'])
    const s = makeStubs()
    gm.attachDevice(s.device as never, s.rhi as never, 'bgra8unorm')
    gm.add(circleSpec())
    expect(built).toEqual(['circle', 'circle'])
  })
})

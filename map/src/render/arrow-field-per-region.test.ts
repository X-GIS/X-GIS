// ═══ A mosaic region's arrows must move through — and be coloured by — ITS OWN current (#1458) ═══
//
// #1459 gave each region its own texel RANGE in the shared arrow state. That was necessary and
// not sufficient: the VELOCITY PAIR was still a single pair for the whole map. `FlowRenderer`
// held one `arrowFieldU`/`arrowFieldV`, fed from `CoverageRenderer.activeFlowField()` — which
// returns the FIRST resident region's field and says so in its own doc comment — and handed
// that one pair to every advected batch, whatever domain it belonged to.
//
// The consequence is NOT a position error. The VS reads `pos` and `origin` from the same texel,
// so `pos − origin` stays inside the leash and screen position is dominated by the CPU-packed
// per-instance lon/lat. What breaks is everything DERIVED from the field:
//
//   - the arrow's band COLOUR, HEADING and SCALE are re-decided every frame from the velocity
//     sampled at its grid-uv position — from the wrong region's texture, that is another
//     domain's water reported as this one's;
//   - the advect STEP moves it through the wrong region's `spanDeg`/`midLatDeg`, so even the
//     drift is a different domain's.
//
// Both are wrong from FRAME 0, which is why a coverage/painted-fraction metric is blind to
// them (issue #1458, comment 2: two such gates passed on the broken code).
//
// THESE ARE CROSS-PATH CHECKS, not static reads. Each drives the REAL `FlowRenderer` and the
// REAL `CompiledArrowStore` and then decodes what actually reached `createBindGroup` /
// `writeBuffer` — the issue's own instruction, after three reasoning-from-reading mistakes in
// its history.

import { describe, it, expect } from 'vitest'
import { FlowRenderer } from './flow-renderer'
import { CompiledArrowStore } from '../graphics/compiled-arrow-store'
import { RetainedArrowDraper } from './material/arrow-retained-material'
import { RetainedArrowAdvectedDraper } from './material/arrow-retained-advected-material'
import type { FlowFieldRegion } from './coverage-renderer'
import type { RhiCommandEncoder, RhiDevice, RhiRenderPass } from '@xgis/engine'

interface BindGroupRec {
  id: number
  entries: ReadonlyArray<{ binding: number; resource: Record<string, unknown> }>
}

/** A recorder deep enough to build both drapers and both pipelines, and to keep every bind
 *  group's ENTRIES — the entries are the evidence: which view landed on which binding. */
function makeCtx() {
  let id = 0
  const bindGroups: BindGroupRec[] = []
  const uniformWrites: Float32Array[] = []
  const passes: Array<{ label?: string; bindGroups: unknown[] }> = []

  const openPass = (desc: { label?: string }): unknown => {
    const rec = { label: desc.label, bindGroups: [] as unknown[] }
    passes.push(rec)
    return {
      setPipeline: () => {},
      setBindGroup: (_g: number, bg: unknown) => void rec.bindGroups.push(bg),
      setViewport: () => {},
      setScissorRect: () => {},
      draw: () => {},
      drawIndexed: () => {},
      end: () => {},
    }
  }

  const rhi = {
    backend: 'webgpu' as const,
    caps: { floatBlendTargets: true, maxSampleCount: 1 },
    createTexture: () => ({ native: `tex${id++}` }),
    createView: (t: { native: string }) => ({ native: `view-of-${t.native}` }),
    destroyTexture: () => {},
    createSampler: () => ({ native: `samp${id++}` }),
    destroySampler: () => {},
    createShaderModule: () => ({ native: 'mod' }),
    createBindGroupLayout: () => ({ native: 'layout' }),
    createBindGroup: (_l: unknown, entries: BindGroupRec['entries']) => {
      const bg = { entries, id: id++ }
      bindGroups.push(bg)
      return bg
    },
    createPipeline: () => ({ native: 'pipe' }),
    createBuffer: (d: { label?: string }) => ({ native: `buf${id++}`, label: d.label }),
    writeBuffer: (_b: unknown, _off: number, src: BufferSource) => {
      // `UniformBlock.buffer` is documented as passable verbatim, so a write can arrive as a raw
      // ArrayBuffer as well as a view — the advected view block takes the former.
      const data: ArrayBufferView =
        src instanceof ArrayBuffer ? new Uint8Array(src) : (src as ArrayBufferView)
      uniformWrites.push(
        new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      )
    },
    writeTexture: () => {},
  }

  const encoder = {
    beginRenderPass: (d: { label?: string }) => openPass(d),
  } as unknown as RhiCommandEncoder

  return { dev: rhi as unknown as RhiDevice, encoder, bindGroups, uniformWrites, passes }
}

/** A recording pass for the DRAW side — `executeItems` drives setPipeline/setBindGroup/draw. */
function drawPass(): RhiRenderPass {
  return {
    setPipeline: () => {},
    setBindGroup: () => {},
    setViewport: () => {},
    setScissorRect: () => {},
    draw: () => {},
    drawIndexed: () => {},
    end: () => {},
  } as unknown as RhiRenderPass
}

/** Two domains that genuinely disagree — different grid, different extent, different latitude.
 *  A twin of one field (the mistake #1458's first gate attempt made) could not tell the fixed
 *  code from the broken code, because both write the same numbers. */
function field(tag: string, over: Partial<FlowFieldRegion> = {}): FlowFieldRegion {
  return {
    u: { native: `u-${tag}` } as never,
    v: { native: `v-${tag}` } as never,
    scale: 1,
    width: 32,
    height: 48,
    spanDeg: [1, 1],
    midLatDeg: 0,
    ...over,
  }
}

const NORTH = field('north', { width: 64, height: 64, spanDeg: [2, 3], midLatDeg: 38 })
const SOUTH = field('south', { width: 23, height: 29, spanDeg: [0.5, 0.4], midLatDeg: 26 })

/** One advected batch's inputs. Two batch scalars — there is nothing per instance any more
 *  (#1520): the instance set is a lattice on the screen and its size is a per-frame decision. */
function advectedInput() {
  return {
    grid: { originLon: -71, originLat: 39, invSpanLon: 0.5, invSpanLat: -0.5 },
    bandTable: new Float32Array(80),
  }
}

/** A camera the store can build a screen lattice from. An orthonormal-ish MVP over a small
 *  camera-relative plane: what matters for these bindings tests is only that the inverse EXISTS,
 *  so the write returns a nonzero instance count and the draw is issued. */
function view() {
  // A plain perspective-ish column-major MVP: x/y scaled, the eye 1000 m up the +z axis looking
  // down, w carrying −z so the inverse is well-conditioned.
  const m = new Float32Array([1e-3, 0, 0, 0, 0, 1e-3, 0, 0, 0, 0, -1e-3, -1, 0, 0, 1, 1000])
  return {
    matrix: m,
    projType: 0,
    globeMode: false,
    centerLon: -70,
    centerLat: 38,
    canvasWidth: 512,
    canvasHeight: 512,
    dpr: 1,
  }
}

/** Stand a real store up on a real FlowRenderer, with one advected batch per region. */
function twoRegions() {
  const ctx = makeCtx()
  const flow = new FlowRenderer(ctx.dev)
  const store = new CompiledArrowStore()
  store.attach(
    ctx.dev,
    new RetainedArrowDraper(ctx.dev, 'bgra8unorm', 1, 256),
    new RetainedArrowAdvectedDraper(ctx.dev, 'bgra8unorm', 1, 256),
  )
  store.setAdvectedSource(flow)
  flow.setArrowFields(
    new Map([
      ['north', NORTH],
      ['south', SOUTH],
    ]),
  )
  const add = (region: string, n: number): void => {
    store.add(
      Float64Array.from({ length: n }, (_, i) => -70 + i),
      Float64Array.from({ length: n }, (_, i) => 38 + i * 0.01),
      Float32Array.from({ length: n }, () => 0),
      Float32Array.from({ length: n }, () => 34),
      Array.from({ length: n }, () => [1, 0, 0, 1] as const),
      0.06,
      1,
      region,
      advectedInput(),
    )
  }
  return { ctx, flow, store, add }
}

/** The velocity views a batch's DRAW bind group actually got — bindings 4 and 5 of group 1
 *  (arrow-retained-advected-material.ts). Read off `createBindGroup`, not off the source. */
function boundFlowViews(bg: BindGroupRec): { u: unknown; v: unknown } {
  const at = (b: number): unknown => bg.entries.find((e) => e.binding === b)?.resource.view
  return { u: at(2), v: at(3) }
}

/** The batch group, told apart from the per-copy uniform group by having a view at binding 2.
 *  The pair sat at 4/5 while bindings 2/3 held the arrow STATE and ORIGIN textures; those are
 *  gone (#1520) and the velocity pair moved down. */
function hasFlowViews(bg: BindGroupRec): boolean {
  return bg.entries.some((e) => e.binding === 2 && e.resource.view !== undefined)
}

describe('the advected DRAW binds the batch’s OWN region field (#1458)', () => {
  it('two regions get two DIFFERENT velocity pairs, each its own', () => {
    const { ctx, store, add } = twoRegions()
    add('north', 4)
    add('south', 6)

    const before = ctx.bindGroups.length
    store.draw(drawPass(), [new Float32Array(32)], view())
    const drawGroups = ctx.bindGroups.slice(before).filter(hasFlowViews).map(boundFlowViews)

    expect(drawGroups).toHaveLength(2)
    expect(drawGroups[0]).toEqual({ u: NORTH.u, v: NORTH.v })
    expect(drawGroups[1]).toEqual({ u: SOUTH.u, v: SOUTH.v })
  })

  it('a batch whose region carries NO field is not drawn at all', () => {
    // The #1419 lifetime contract, now per region: an evicted domain's textures are DESTROYED,
    // and a batch that outlives its region by a frame must draw nothing rather than bind them.
    const { ctx, flow, store, add } = twoRegions()
    add('north', 4)
    add('south', 6)
    flow.setArrowFields(new Map([['north', NORTH]]))

    const before = ctx.bindGroups.length
    const calls = store.draw(drawPass(), [new Float32Array(32)], view())
    const drawGroups = ctx.bindGroups.slice(before).filter(hasFlowViews).map(boundFlowViews)
    expect(drawGroups).toEqual([{ u: NORTH.u, v: NORTH.v }])
    expect(calls).toBe(1)
  })
})

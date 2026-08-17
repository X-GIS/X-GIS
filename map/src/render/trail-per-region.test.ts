// ═══ A mosaic region's IBFV trail must be ITS OWN recursive filter (#1499) ═══
//
// The TRAIL twin of #1458's arrow fix, and the last thing that was still one-per-map. #1458 gave
// every region its own VELOCITY pair for the arrows; the trail kept ONE `FlowStepper` — one
// ping-pong pair, one dt clock — stepped once per frame with `CoverageRenderer.activeFlowField()`,
// the FIRST resident region's field. Its own doc comment conceded it: "ONE region, not all of
// them."
//
// TWO THINGS WERE WRONG AT ONCE, and the second is why the report reads as "the other domains
// stand still":
//
//   - only the first region's field was ever ADVECTED, so the history moved through one domain's
//     currents, one domain's degree span and one domain's centre latitude;
//   - every animated region's drape then BOUND that same image (coverage-renderer's draw loop
//     handed `flow.view` to all of them), so a sibling domain painted the first domain's water.
//
// FAIL-BEFORE, DERIVED RATHER THAN HOPED FOR. Each arm below is red on the pre-#1499 code BY
// CONSTRUCTION, not by a threshold:
//
//   1. one stepper ⇒ one `flow-advect` pass per frame however many regions are declared, and one
//      pair of ping-pong views. `advectPasses(2 regions) === 2` and "the two regions write
//      DIFFERENT attachments" are both unsatisfiable with a single pair.
//   2. one `currentView` getter ⇒ every region reads the same image. `trailViewFor(a) !==
//      trailViewFor(b)` cannot hold.
//   3. one dt clock ⇒ `consumeDt` called twice per frame hands the SECOND region a zero delta, so
//      a naive loop over one stepper freezes every domain but the first. This is the arm that
//      catches the tempting half-fix (loop the pass, keep the stepper).
//   4. one bind-group memo keyed by the read side alone ⇒ two regions with different velocity
//      pairs invalidate each other every step, minting a GPU object per region per frame.
//
// RECORDER DISCIPLINE, as in `flow-renderer.test.ts` and `arrow-field-per-region.test.ts`: every
// property here is one a frame cannot show. A trail advected through the wrong domain's current
// still animates — wrongly — so what is asserted is what actually reached `beginRenderPass` /
// `createBindGroup` / `writeBuffer`, never what the source says it does.

import { describe, it, expect } from 'vitest'
import { FlowRenderer } from './flow-renderer'
import type { FlowFieldRegion } from './coverage-renderer'
import type { RhiCommandEncoder, RhiDevice } from '@xgis/engine'

interface PassRec {
  label?: string
  /** The colour attachment this pass writes — the ping-pong side being advected INTO. */
  view: unknown
  bindGroups: unknown[]
}

interface BindGroupRec {
  id: number
  entries: ReadonlyArray<{ binding: number; resource: Record<string, unknown> }>
}

function makeCtx() {
  let id = 0
  const passes: PassRec[] = []
  const bindGroups: BindGroupRec[] = []
  const destroyed: unknown[] = []
  const uniforms: number[][] = []

  const openPass = (desc: { colorAttachments: { view: unknown }[]; label?: string }): unknown => {
    const rec: PassRec = { label: desc.label, view: desc.colorAttachments[0]!.view, bindGroups: [] }
    passes.push(rec)
    return {
      setPipeline: () => {},
      setBindGroup: (_g: number, bg: unknown) => void rec.bindGroups.push(bg),
      draw: () => {},
      end: () => {},
    }
  }

  const rhi = {
    backend: 'webgl2' as const,
    caps: { floatBlendTargets: true, maxSampleCount: 1 },
    createTexture: () => ({ native: `tex${id++}` }),
    createView: (t: { native: string }) => ({ native: `view-of-${t.native}` }),
    destroyTexture: (t: unknown) => void destroyed.push(t),
    createSampler: () => ({ native: `samp${id++}` }),
    destroySampler: (s: unknown) => void destroyed.push(s),
    createShaderModule: () => ({ native: 'mod' }),
    createBindGroupLayout: () => ({ native: 'layout' }),
    createBindGroup: (_l: unknown, entries: BindGroupRec['entries']) => {
      const bg = { entries, id: id++ }
      bindGroups.push(bg)
      return bg
    },
    createPipeline: () => ({ native: 'pipe' }),
    createBuffer: () => ({ native: 'buf' }),
    writeBuffer: (_b: unknown, _o: number, d: Float32Array) => void uniforms.push([...d]),
    writeTexture: () => {},
    // `asScreenPassDevice` narrows on exactly these — the WebGL2 arm nests the offscreen pass
    // off the DEVICE, which is what lets these tests run with no frame encoder at all.
    beginScreenPass: () => ({}),
    endScreenPass: () => {},
    beginOffscreenPass: openPass,
    readPixelRg32ui: () => [0, 0],
  }

  return { dev: rhi as unknown as RhiDevice, passes, bindGroups, destroyed, uniforms }
}

/** Two domains that genuinely disagree — different grid, different extent, different latitude,
 *  different velocity pair. A twin of one field could not tell the fixed code from the broken
 *  code, because both would write the same numbers. */
function field(tag: string, over: Partial<FlowFieldRegion> = {}): FlowFieldRegion {
  return {
    u: { native: `u-${tag}` } as never,
    v: { native: `v-${tag}` } as never,
    valid: { native: `valid-${tag}` } as never,
    scale: 1,
    width: 32,
    height: 48,
    spanDeg: [1, 1],
    midLatDeg: 0,
    ...over,
  }
}

const WEST = field('west', { width: 32, height: 48, spanDeg: [0.8, 2.6], midLatDeg: 38 })
const EAST = field('east', { width: 24, height: 36, spanDeg: [0.5, 1.1], midLatDeg: 26 })

const frameAt = (ms: number) => ({ elapsedMs: ms, encoder: null as RhiCommandEncoder | null })

/** The advect passes only — the clears a fresh pair takes are a different claim. */
const advects = (passes: PassRec[]): PassRec[] => passes.filter((p) => p.label === 'flow-advect')

/** The velocity views a step's bind group actually got — bindings 1 and 2 of the advect group
 *  (flow-advect-material.ts). Read off `createBindGroup`, not off the source. */
function boundField(bg: BindGroupRec): { u: unknown; v: unknown } {
  const at = (b: number): unknown => bg.entries.find((e) => e.binding === b)?.resource.view
  return { u: at(1), v: at(2) }
}

/** One frame of the pass's loop: a step per declared region, off the same declaration. */
function frame(fr: FlowRenderer, ms: number, fields: ReadonlyMap<string, FlowFieldRegion>): void {
  fr.setTrailRegions(fields)
  for (const [region, f] of fields) fr.step(frameAt(ms), region, f)
}

const MOSAIC = new Map<string, FlowFieldRegion>([
  ['west', WEST],
  ['east', EAST],
])

describe('the IBFV trail is per region (#1499)', () => {
  it('TWO regions ⇒ TWO advection steps, each into its OWN pair', () => {
    // The report itself: with one stepper this frame issues ONE advect pass, so the second
    // domain's water never moves at all — it only ever shows the first domain's image.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    frame(fr, 0, MOSAIC)
    t.passes.length = 0
    frame(fr, 16, MOSAIC)

    const drawn = advects(t.passes)
    expect(drawn, 'one advect pass per declared region').toHaveLength(2)
    // ...and they are not the same texture. A single pair cannot satisfy this.
    expect(drawn[0]!.view).not.toEqual(drawn[1]!.view)
    // Each step read the velocity pair of the region it belongs to — the whole failure was a
    // sibling domain advected through another domain's current.
    expect(boundField(drawn[0]!.bindGroups[0] as BindGroupRec)).toEqual({ u: WEST.u, v: WEST.v })
    expect(boundField(drawn[1]!.bindGroups[0] as BindGroupRec)).toEqual({ u: EAST.u, v: EAST.v })
  })

  it('each region reports its OWN advected image — what its drape binds', () => {
    // `trailViewFor` is what `CoverageRenderer.render` asks per region. One `currentView` for the
    // map is exactly how every domain ended up painting the first one's water.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    expect(fr.trailViewFor('west'), 'null before the first step').toBeNull()
    frame(fr, 0, MOSAIC)
    const west = fr.trailViewFor('west')
    const east = fr.trailViewFor('east')
    expect(west).not.toBeNull()
    expect(east).not.toBeNull()
    expect(west).not.toEqual(east)
    // A region that carries no trail is not served a sibling's.
    expect(fr.trailViewFor('nowhere')).toBeNull()
  })

  it('every region advects by the REAL dt — one clock each, not one for the map', () => {
    // THE HALF-FIX THIS CATCHES: loop the pass over the regions but keep one FlowStepper.
    // `consumeDt` is a delta of the frame clock, so the first call in a frame takes the whole
    // interval and every later one gets 0 — the second domain would freeze while the first ran,
    // which is the reported symptom with a different cause. Each stepper owns its own clock.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    frame(fr, 1000, MOSAIC) // frame 1: dt is 0 for BOTH, there is no earlier frame
    t.uniforms.length = 0
    frame(fr, 1016, MOSAIC)

    // Two packed AdvectParams, one per region: [stepX, stepY, ...] (flow-advect-params.ts).
    expect(t.uniforms).toHaveLength(2)
    for (const [i, tag] of ['west', 'east'].entries()) {
      const why = `${tag} advected by a zero dt — a shared clock ate it`
      expect(t.uniforms[i]![0], why).toBeGreaterThan(0)
      expect(t.uniforms[i]![1], why).toBeGreaterThan(0)
    }
    // The two domains' steps are NOT the same numbers: different degree spans and different
    // centre latitudes, which is the geometry half of "its own recursive filter".
    expect(t.uniforms[0]!.slice(0, 2)).not.toEqual(t.uniforms[1]!.slice(0, 2))
  })

  it('the bind-group memo is per region — two per region at rest, not one per frame', () => {
    // Keyed by the read side ALONE, the two domains' differing velocity pairs would invalidate
    // each other on every step: a fresh GPU object per region per frame, on the 60 Hz path.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    for (let i = 0; i < 10; i++) frame(fr, i * 16, MOSAIC)
    expect(t.bindGroups, 'two ping-pong sides × two regions').toHaveLength(4)
  })

  it('EVICTION: the dropped region’s pair is destroyed and its sibling’s survives', () => {
    // The lifetime contract `setArrowFields` carries, in the trail's own terms (#1419/#1458): a
    // region the mosaic evicts must not keep a ping-pong pair alive for the rest of the session,
    // and retiring it must not disturb the domain still on screen.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    frame(fr, 0, MOSAIC)
    t.destroyed.length = 0
    t.passes.length = 0

    frame(fr, 16, new Map([['west', WEST]]))

    expect(t.destroyed, 'the evicted region’s two ping-pong textures').toHaveLength(2)
    expect(fr.trailViewFor('east'), 'the evicted region has no trail left').toBeNull()
    expect(fr.trailViewFor('west'), 'the surviving domain kept its own pair').not.toBeNull()
    // KEPT, not rebuilt — and that is the assertion, not a nicety: a survivor whose pair was
    // reallocated would take the fresh-pair clears again and lose its whole history to a
    // neighbour's eviction. One advect, no clears.
    expect(t.passes.map((p) => p.label)).toEqual(['flow-advect'])
  })

  it('a region re-declared after eviction starts from a CLEARED history', () => {
    // The mirror of the arm above. A fresh pair holds undefined contents and a recursive filter
    // feeds on them rather than overwriting them, so the re-armed domain must take the two
    // clears again — the stepper it lost was destroyed, not parked.
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    frame(fr, 0, MOSAIC)
    frame(fr, 16, new Map([['west', WEST]]))
    t.passes.length = 0
    frame(fr, 32, MOSAIC)
    expect(t.passes.filter((p) => p.label === 'flow-clear')).toHaveLength(2)
  })

  it('dispose() frees EVERY region’s pair', () => {
    const t = makeCtx()
    const fr = new FlowRenderer(t.dev)
    frame(fr, 0, MOSAIC)
    t.destroyed.length = 0
    fr.dispose()
    // Two pairs (2 × 2 textures) + the shared sampler.
    expect(t.destroyed).toHaveLength(5)
    expect(fr.trailViewFor('west')).toBeNull()
    expect(fr.trailViewFor('east')).toBeNull()
  })
})

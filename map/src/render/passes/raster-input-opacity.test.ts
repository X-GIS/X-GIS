// ═══ `input`-driven opacity reaches the raster + DEM passes (#2166 L3) ═══
//
// #1539 routed an `input-dependent` paint shape — a `data-driven` shape whose
// expression reads a declared `input` but NO feature field — onto the per-frame
// CPU resolve, so `| opacity-[dim]` lands in the existing opacity uniform and
// works on both backends. `resolveNumberShape` only does that when it is HANDED
// the store: its 4th parameter. `resolved-show.ts` (the vector path) passes it;
// the raster and DEM-relief passes did not, so their `data-driven` arm fell
// through to the flat `1` fallback in paint-shape-resolve.ts. The AUTHORED
// DEFAULT was lost on frame one — before any interaction — and `setInput` moved
// nothing on a raster or hillshade layer while moving the identical expression
// on a fill layer.
//
// The shapes below are built by the REAL compiler pipeline (Lexer → Parser →
// lower → optimize → emitCommands), not hand-written. That is load-bearing:
// `classification` is attached by `optimize`, so a hand-built shape (or one
// compiled without that stage) carries `classification: undefined`, takes the
// per-feature fallback in BOTH the fixed and the broken tree, and the test would
// pass either way — CLAUDE.md §12's "the inputs carry no information" trap.
//
// GPU-free: the RHI encoder + renderers are stubs, so this rides the
// `test (map)` leg.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, optimize, emitCommands } from '@xgis/compiler'
import { opaquePass } from './opaque-pass'
import { applyHillshadePaint, hillshadePass } from './hillshade-pass'
import { InputStore } from '../input-store'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

/** One raster layer and one raster-dem layer, both bound to the SAME declared
 *  input through a utility — the exact authoring `_input-live-set.spec.ts`
 *  drives on a fill layer. The default is 0.4, deliberately NOT 1, so the
 *  un-set default is itself the witness. */
const SRC = `xgis 1
input dim: f32 = 0.4
source basemap { type: raster url: "/checker-tile.png" }
source demsrc { type: "raster-dem" url: "/dem-fixture.png" encoding: mapbox }
layer tiles { source: basemap | opacity-[dim] }
layer relief { source: demsrc | opacity-[dim] hillshade-exaggeration-0.7 }
`

function compiled() {
  const ast = new Parser(new Lexer(SRC).tokenize()).parse()
  const commands = emitCommands(optimize(lower(ast))) as unknown as {
    inputs: never
    shows: { targetName: string; paintShapes: { common: { opacity: unknown } } }[]
  }
  const store = new InputStore()
  store.reset(commands.inputs)
  const show = (target: string) => commands.shows.find((s) => s.targetName === target)!
  return { store, raster: show('basemap'), dem: show('demsrc') }
}

/** Minimal RHI-frame stub — the opaque pass originates its sub-pass through
 *  `requireRhiFrame`, so the bridges must be non-null even though nothing here
 *  reads a pixel. Modelled on opaque-pass-rhi-wiring.test.ts. */
function rasterHarness(rasterShow: unknown, inputs: InputStore) {
  const opacities: number[] = []
  const ctx = {
    rhiEncoder: { beginRenderPass: () => ({ end() {} }) },
    rhiScreenView: {},
    rhiColorView: {},
    rhiStencilView: {},
    rhiSceneResolveView: {},
    rhiColorViewScreen: {},
    passScope: (_l: string, fn: () => void) => fn(),
    useResolve: false,
    rt: { pickTexture: undefined, pickView: null },
    projection: makeProjectionToken(0, 0, 0),
    camera: {},
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    _elapsedMs: 0,
  } as unknown as FrameContext
  const host = {
    gpuTimer: undefined,
    _rasterShow: rasterShow,
    _elapsedMs: 0,
    inputs,
    camera: {
      globeMode: false,
      zoom: 3,
      centerX: 0,
      centerY: 0,
      getViewForProjection: () => ({ matrix: new Float32Array(16), logDepthFc: 1 }),
    },
    pointRenderer: {},
    rasterRenderer: {
      setOpacity: (v: number) => opacities.push(v),
      setColorAdjust: () => undefined,
      setResampling: () => undefined,
      hasSource: () => false,
      render: () => undefined,
    },
    underOccluder: undefined,
    coverageRenderer: { hasCoverage: () => false, render: () => undefined },
    flowRenderer: null,
    renderer: { renderToPass: () => undefined, renderGraticuleOverlay: () => undefined },
  }
  const scene = {
    opaqueGroups: [{ shows: [] }],
    resolveOwner: 'none',
    hasPoints: false,
    hasOit: false,
  } as unknown as SceneView
  return { ctx, host, scene, opacities }
}

/** The DEM-relief twin of `rasterHarness`, and it exists because the first cut of
 *  this file did NOT have one: both hillshade arms called `applyHillshadePaint`
 *  directly and handed it the store themselves, so nothing outside the browser
 *  render leg drove `HillshadePass.execute` — and deleting `, host.inputs` from
 *  hillshade-pass.ts:113 left every arm in this file GREEN (`inputs` is an
 *  OPTIONAL parameter, so tsc is silent about it too). Found by the #2218 review
 *  and reproduced before this harness was written. */
function hillshadeHarness(demShow: unknown, inputs: InputStore) {
  const opacities: number[] = []
  const ctx = {
    rhiEncoder: { beginRenderPass: () => ({ end() {} }) },
    rhiScreenView: {},
    rhiColorView: {},
    rhiStencilView: {},
    rhiSceneResolveView: {},
    rhiColorViewScreen: {},
    passScope: (_l: string, fn: () => void) => fn(),
    useResolve: false,
    projection: makeProjectionToken(0, 0, 0),
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    _elapsedMs: 0,
  } as unknown as FrameContext
  const host = {
    _hillshadeShow: demShow,
    _elapsedMs: 0,
    inputs,
    camera: { zoom: 3 },
    hillshadeRenderer: {
      // must be true, or execute() returns before the paint resolve
      hasSource: () => true,
      setOpacity: (v: number) => opacities.push(v),
      setParams: () => undefined,
      render: () => undefined,
    },
  }
  const scene = { resolveOwner: 'none' } as unknown as SceneView
  return { ctx, host, scene, opacities }
}

describe('input-dependent opacity on the raster + DEM passes (#2166 L3)', () => {
  it('the compiled shape really is the input-dependent case (instrument check)', () => {
    const { raster, dem } = compiled()
    for (const [half, show] of [
      ['raster', raster],
      ['hillshade', dem],
    ] as const) {
      const shape = show.paintShapes.common.opacity as {
        kind: string
        expr?: { classification?: string }
      }
      expect(shape.kind, `${half}: compiled opacity shape is not data-driven`).toBe('data-driven')
      expect(
        shape.expr?.classification,
        `${half}: the compiled shape carries no 'input-dependent' classification, so this ` +
          `file would pass identically with the fix reverted — re-check the compile pipeline ` +
          `(optimize attaches it).`,
      ).toBe('input-dependent')
    }
  })

  it('RASTER: the opaque pass resolves the authored input default (0.4), not the flat 1', () => {
    const { store, raster } = compiled()
    const h = rasterHarness(raster, store)
    opaquePass.execute(h.ctx, h.scene, h.host as never)
    expect(
      h.opacities.at(-1),
      'RASTER half: opaque-pass.ts did not hand the InputStore to resolveNumberShape, so the ' +
        "input-dependent shape took paint-shape-resolve.ts's per-feature fallback of 1 and the " +
        'authored default 0.4 never reached RasterRenderer.setOpacity',
    ).toBeCloseTo(0.4, 6)
  })

  it('RASTER: setInput moves the resolved opacity live', () => {
    const { store, raster } = compiled()
    store.set('dim', 0.9)
    const h = rasterHarness(raster, store)
    opaquePass.execute(h.ctx, h.scene, h.host as never)
    expect(
      h.opacities.at(-1),
      'RASTER half: setInput("dim", 0.9) did not reach the raster opacity uniform — the pass is ' +
        'resolving without the InputStore',
    ).toBeCloseTo(0.9, 6)
  })

  it('HILLSHADE: the hillshade pass resolves the authored input default (0.4), not the flat 1', () => {
    const { store, dem } = compiled()
    const h = hillshadeHarness(dem, store)
    hillshadePass.execute(h.ctx, h.scene, h.host as never)
    expect(
      h.opacities.at(-1),
      'HILLSHADE half: hillshade-pass.ts did not hand the InputStore to applyHillshadePaint, so ' +
        'the DEM-relief layer opacity fell back to 1 and the authored default 0.4 was lost',
    ).toBeCloseTo(0.4, 6)
  })

  it('HILLSHADE: setInput moves the resolved opacity live', () => {
    const { store, dem } = compiled()
    store.set('dim', 0.9)
    const h = hillshadeHarness(dem, store)
    hillshadePass.execute(h.ctx, h.scene, h.host as never)
    expect(
      h.opacities.at(-1),
      'HILLSHADE half: setInput("dim", 0.9) did not reach the DEM-relief opacity — the pass is ' +
        'resolving without the InputStore',
    ).toBeCloseTo(0.9, 6)
  })

  // The two arms above drive the PASS, so they cover both hillshade lines: the
  // `host.inputs` argument at hillshade-pass.ts:113 AND the 4th argument of the
  // resolve inside the helper. This third arm pins the HELPER on its own, so a
  // red run distinguishes which of the two broke (§12: cut each half separately).
  it('HILLSHADE: applyHillshadePaint honours its own `inputs` parameter', () => {
    const { store, dem } = compiled()
    const seen: number[] = []
    const hr = { setOpacity: (v: number) => seen.push(v), setParams: () => undefined }
    applyHillshadePaint(hr as never, dem as never, 3, 0, store)
    expect(
      seen.at(-1),
      'HILLSHADE leaf: applyHillshadePaint was HANDED the store and still resolved without it — ' +
        'the 4th argument of its resolveNumberShape call is gone (the pass-level arms above ' +
        'would red too; this one says the break is in the helper, not the plumbing)',
    ).toBeCloseTo(0.4, 6)
  })
})

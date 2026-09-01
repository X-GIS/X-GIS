// ═══ The InputStore reaches the background clear resolve (#2166 L3 follow-up) ═══
//
// The last call site of the family #2218 fixed. `resolveColorShape` /
// `resolveNumberShape` evaluate an `input-dependent` shape — a `data-driven`
// shape whose expression reads a declared `input` but NO feature field — only
// when they are HANDED the store as their 4th argument. Without it the
// `data-driven` arm falls through to the historical per-feature fallback
// (`null` for colour, `1` for number), silently losing the authored value.
// `resolved-show.ts` passes the store; the raster and DEM-relief passes did not
// (#2218); `background-pass.ts` was the one left.
//
// UNLIKE the raster/DEM halves, this one is LATENT, NOT LIVE — it moves no
// pixel today, and that is the honest claim. `_backgroundColorShape` /
// `_backgroundOpacityShape` have exactly four writers, all in
// style-top-level.ts (two resets to null, two assignments), and both
// assignments build `{ kind: 'zoom-interpolated' }` from the AST
// `BackgroundStatement` directly — the background never reads a compiled
// `paintShapes` entry at all. So no style can currently produce an
// `input-dependent` background shape, and nothing here is a bug report. It is
// correctness-by-construction: the call site can no longer be the thing that
// drops the value the day a style path does produce one.
//
// What makes that worth doing NOW rather than when a style path appears:
// `_backgroundColorShape` already has TWO consumers, and before this change
// they disagreed. The flat/cylindrical clear resolves it here; the
// sphere/globe path threads the SAME shape object into the synthetic
// earth-surface show (map.ts:3287 → buildSyntheticEarthSurfaceShow), which
// resolves through resolved-show.ts:287 — and that one has always passed the
// store. So the failure this removes was never going to be a uniformly dead
// default; it was a PROJECTION-DEPENDENT one, right on globe and wrong on
// mercator, which is the expensive kind to attribute.
//
// That is also why the shapes below are compiled off a FILL layer and then
// INSTALLED on the background host: the background style path cannot route
// them. Compiling them for real is still load-bearing — `classification` is
// attached by `optimize`, so a hand-written shape would carry
// `classification: undefined`, take the fallback in BOTH the fixed and the
// broken tree, and this file would pass either way (CLAUDE.md §12's "the
// inputs carry no information" trap). The instrument check below asserts the
// classification is really there before any arm trusts it.
//
// Fail-before, each half separately: drop `, host.inputs` from the
// resolveColorShape call in background-pass.ts and only the COLOUR arms go
// red; drop it from the resolveNumberShape call and only the ALPHA arms do.
// The two are independent by construction — the colour shape decides rgb, the
// opacity shape multiplies into a.
//
// GPU-free: the only device interaction the pass makes is
// `rhiEncoder.beginRenderPass({ colorAttachments: [{ clearValue }] })` (the F3b
// seam), which a fake encoder intercepts. Rides the `test (map)` leg.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, optimize, emitCommands } from '@xgis/compiler'
import type { PropertyShape } from '@xgis/compiler'
import { backgroundPass } from './background-pass'
import { InputStore } from '../input-store'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

/** One fill layer bound to a colour input AND an f32 input, so a single compile
 *  yields both shapes the background pass resolves. The defaults are chosen so
 *  every asserted number is a function of BOTH inputs and the base colour:
 *  `#f59e0b` is nothing like BASE_BG, and 0.4 is not 1 (the fallback), so the
 *  un-set defaults are themselves the witness. */
const SRC = `xgis 1
input dim: f32 = 0.4
input hl: color = #f59e0b
source w { type: geojson url: "w.geojson" }
layer tinted { source: w | fill-[hl] opacity-[dim] }
`

/** The base `_backgroundColor` a constant `background { fill: … }` would set.
 *  Deliberately NOT the input colour: when the colour resolve loses the store
 *  it returns null and the pass keeps this, so the two cases never collide. */
const BASE_BG: readonly [number, number, number, number] = [0.1, 0.2, 0.3, 1]

/** `#f59e0b` in the 0..1 RGBA the resolver yields. */
const HL_RGB: readonly [number, number, number] = [245 / 255, 158 / 255, 11 / 255]

function compiled(): {
  store: InputStore
  colorShape: PropertyShape<readonly [number, number, number, number]>
  opacityShape: PropertyShape<number>
} {
  const ast = new Parser(new Lexer(SRC).tokenize()).parse()
  const commands = emitCommands(optimize(lower(ast))) as unknown as {
    inputs: never
    shows: {
      paintShapes: {
        fill: { fill: PropertyShape<readonly [number, number, number, number]> }
        common: { opacity: PropertyShape<number> }
      }
    }[]
  }
  const store = new InputStore()
  store.reset(commands.inputs)
  const ps = commands.shows[0]!.paintShapes
  return { store, colorShape: ps.fill.fill, opacityShape: ps.common.opacity }
}

/** Drive the real `backgroundPass.execute` on the flat (mercator, projType 0)
 *  path and return the RGBA clear tuple it hands to `beginRenderPass`. Passing
 *  `inputs: undefined` reproduces the pre-fix host exactly. */
function capturedClear(
  colorShape: PropertyShape<readonly [number, number, number, number]> | null,
  opacityShape: PropertyShape<number> | null,
  inputs: InputStore | undefined,
): readonly [number, number, number, number] {
  let clear: readonly [number, number, number, number] | undefined
  const ctx = {
    projection: makeProjectionToken(0, 0, 0), // mercator → flat, worldBand !== 'sphere-full'
    camera: { zoom: 5 },
    elapsedMs: 0,
    rhiEncoder: {
      beginRenderPass(desc: {
        colorAttachments: { clearValue?: readonly [number, number, number, number] }[]
      }): { end: () => void } {
        clear = desc.colorAttachments[0]?.clearValue
        return { end(): void {} }
      },
    },
    rhiScreenView: {},
    rhiColorView: {},
    rhiStencilView: {},
    rhiSceneResolveView: {},
    rhiColorViewScreen: {},
    passScope: (_label: string, fn: () => void): void => {
      fn()
    },
  } as unknown as FrameContext

  const host = {
    _backgroundColor: BASE_BG,
    _backgroundColorShape: colorShape,
    _backgroundOpacityShape: opacityShape,
    inputs,
  }

  backgroundPass.execute(
    ctx,
    {} as unknown as SceneView,
    host as unknown as Parameters<typeof backgroundPass.execute>[2],
  )
  if (!clear) throw new Error('the background pass never called beginRenderPass')
  return clear
}

describe('input-dependent background clear resolve (#2166 L3 follow-up)', () => {
  it('both compiled shapes really are the input-dependent case (instrument check)', () => {
    const { colorShape, opacityShape } = compiled()
    for (const [half, shape] of [
      ['colour', colorShape],
      ['opacity', opacityShape],
    ] as const) {
      const s = shape as { kind: string; expr?: { classification?: string } }
      expect(s.kind, `${half}: the compiled shape is not data-driven`).toBe('data-driven')
      expect(
        s.expr?.classification,
        `${half}: the compiled shape carries no 'input-dependent' classification, so every arm ` +
          `below would pass identically with the fix reverted — re-check the compile pipeline ` +
          `(optimize attaches it).`,
      ).toBe('input-dependent')
    }
  })

  it('COLOUR: the clear takes the authored input default (#f59e0b), not the base background', () => {
    const { store, colorShape } = compiled()
    const clear = capturedClear(colorShape, null, store)
    expect(
      [clear[0], clear[1], clear[2]],
      'background-pass.ts did not hand the InputStore to resolveColorShape, so the ' +
        'input-dependent shape returned null and the clear kept the constant _backgroundColor',
    ).toEqual([
      expect.closeTo(HL_RGB[0], 6),
      expect.closeTo(HL_RGB[1], 6),
      expect.closeTo(HL_RGB[2], 6),
    ])
  })

  it('COLOUR: setInput moves the clear colour live', () => {
    const { store, colorShape } = compiled()
    store.set('hl', '#ff0000')
    const clear = capturedClear(colorShape, null, store)
    expect(
      [clear[0], clear[1], clear[2]],
      'setInput("hl", "#ff0000") did not reach the background clear — the pass is resolving ' +
        'without the InputStore',
    ).toEqual([1, 0, 0])
  })

  it('ALPHA: the clear alpha takes the authored input default (1 × 0.4), not the flat 1', () => {
    const { store, opacityShape } = compiled()
    expect(
      capturedClear(null, opacityShape, store)[3],
      'background-pass.ts did not hand the InputStore to resolveNumberShape, so the ' +
        "input-dependent shape took paint-shape-resolve.ts's per-feature fallback of 1 and the " +
        'authored default 0.4 never multiplied into the clear alpha',
    ).toBeCloseTo(0.4, 6)
  })

  it('ALPHA: setInput moves the clear alpha live', () => {
    const { store, opacityShape } = compiled()
    store.set('dim', 0.9)
    expect(
      capturedClear(null, opacityShape, store)[3],
      'setInput("dim", 0.9) did not reach the background clear alpha — the pass is resolving ' +
        'without the InputStore',
    ).toBeCloseTo(0.9, 6)
  })

  it('both shapes together: input colour with the input alpha multiplied in', () => {
    const { store, colorShape, opacityShape } = compiled()
    const clear = capturedClear(colorShape, opacityShape, store)
    expect(clear[0]).toBeCloseTo(HL_RGB[0], 6)
    expect(clear[1]).toBeCloseTo(HL_RGB[1], 6)
    expect(clear[2]).toBeCloseTo(HL_RGB[2], 6)
    // #f59e0b is opaque, so the resolved colour's own alpha is 1 and the
    // opacity input is the whole of the clear alpha.
    expect(clear[3]).toBeCloseTo(0.4, 6)
  })

  // ─── The control: what the call site did BEFORE the store was passed ───
  //
  // Same shapes, host with no `inputs`. This is not a redundant restatement of
  // the assertions above — it is what makes them attributable. Without it a
  // green suite is consistent with the resolvers ignoring the store entirely
  // and the values arriving by some other route.

  it('CONTROL: with no InputStore the colour falls back to the constant background', () => {
    const { colorShape } = compiled()
    const clear = capturedClear(colorShape, null, undefined)
    expect([clear[0], clear[1], clear[2]]).toEqual([BASE_BG[0], BASE_BG[1], BASE_BG[2]])
  })

  it('CONTROL: with no InputStore the alpha falls back to the flat 1', () => {
    const { opacityShape } = compiled()
    expect(capturedClear(null, opacityShape, undefined)[3]).toBeCloseTo(1, 6)
  })
})

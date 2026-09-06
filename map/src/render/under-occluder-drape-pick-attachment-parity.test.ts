// ═══ #2571 — under-occluder + globe drape must match the opaque pass's MRT attachment ═══
//
// opaque-pass.ts attaches its rg32uint pick target from `pickTargetsEnabled(caps)`
// (QUALITY.picking && caps.presentablePassMrt). UnderOccluderRenderer.render (:227, pre-fix)
// and VectorDrapeRenderer.renderGlobeFills's draper.draw call (:443, pre-fix) instead picked
// their pipeline from the bare `isPickEnabled()` (QUALITY.picking alone). On WebGPU
// (`presentablePassMrt: true`, rhi-webgpu.ts:414) the two predicates always agree, so this
// never surfaced there. On WebGL2 (`presentablePassMrt: false`, rhi-webgl2.ts:761) they
// diverge exactly when picking is on: the two draw sites still build/select a 2-target pick
// pipeline while the pass attaches only 1 colour attachment. `rhi-webgl2.ts:1467` doesn't
// reject this outright (only an EXPLICIT `writeMask` on a later target does, :1375-1382, and
// neither pick descriptor sets one) — it just forces blending OFF for the WHOLE pipeline,
// since ES 3.00 has no per-draw-buffer blend state. So the occluder sphere and every draped
// tile composited unblended, silently — which is why #2319 (the sibling coverage/tile-point
// fix, same defect shape) never caught these two.
//
// The fix reads `pickTargetsEnabled(this.rhi.caps)` at both sites — the SAME authority the
// pass attaches its MRT from (already how raster-renderer.ts and tile-point-draw.ts pick
// theirs) — so pipeline target count and pass attachment count can never disagree, by
// construction.
//
// Driven over the REAL chain — installWebGPUStub + initGPU + the renderer's own real
// constructor + render()/renderGlobeFills() — spying on `ctx.rhi.createPipeline` and reading
// `desc.colorTargets.length`, the same idiom as hillshade-pass-pick-attachment-parity.test.ts.
// Two differences from that model, both structural, both explained here rather than silently
// copied:
//
//  1. Neither renderer here defers its Material behind an async shader-emit cache the way
//     HillshadeRenderer's `materialFor` does (`peekShaderSources`/`requestShaderSources`).
//     under-occluder-renderer.ts and vector-drape-renderer.ts (via RasterDraper) build their
//     shader source through `wgslFor`/`glslStagesFor` (material/wgsl-for.ts), which run their
//     emit thunk SYNCHRONOUSLY — no worker, no promise. So one drive() per arm is enough; no
//     settle()/second-drive dance is needed.
//
//  2. BOTH renderers build their non-pick (1-target) Material EAGERLY in the constructor
//     (UnderOccluderRenderer :115, RasterDraper — constructed by VectorDrapeRenderer — :76),
//     unconditionally, whether or not picking is on. That pipeline is harmless, correct
//     infrastructure in every arm (a 1-target pipeline is never the thing #2571 puts out of
//     step with a 2-attachment pass) and is not itself part of the defect. The PICK Material
//     is built lazily, on the first pick-enabled draw (pickMat(), `??=`). So for a FRESH
//     renderer+ctx driving exactly one render call, the LAST pipeline `createPipeline` was
//     asked to build is exactly the one this call selects: the ctor's 1-target pipeline when
//     `pickTargetsEnabled` resolves false (reused, no new build), or the freshly-built pick
//     pipeline when it resolves true. Asserting on that last call is what stays non-vacuous
//     AND correctly attributes the failure — asserting every captured pipeline must equal the
//     arm's expected count would spuriously fail the always-1-target ctor pipeline in the
//     picking-ON arms, which is not the bug.
//
// The installed WebGPU stub always reports `presentablePassMrt: true` (a WebGPU baseline
// truth, rhi-webgpu.ts:412-414) — there is no way to get a `false` device through initGPU.
// The `presentablePassMrt: false` arms (the ones that actually red today) therefore replace
// `ctx.rhi.caps` with a copy carrying `false` before driving the render: `caps` is a plain
// instance field whose VALUE is frozen (`Object.freeze({...})`), not a frozen property
// descriptor and not a getter, so reassigning the whole field to a new object is a legal
// runtime write — only the TS `readonly` needs a cast to get past.
//
// Fail-before (see the #2571 cut-proof runs): reverting either renderer's read back to the
// bare `isPickEnabled()` reds picking=true + presentablePassMrt=false for THAT renderer only,
// naming it — the sibling renderer and every other arm stay green.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { Camera } from '../camera'
import { QUALITY } from '@xgis/engine'
import { UnderOccluderRenderer } from './under-occluder-renderer'
import { VectorDrapeRenderer, type DrapeBakeProvider } from './vector-drape-renderer'
import type { GPUTile } from './vector-tile-renderer-types'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

const origPicking = QUALITY.picking
afterEach(() => {
  QUALITY.picking = origPicking
})

const W = 800
const H = 600
const DPR = 1
const GLOBE_PROJ_TYPE = 7

/** A fresh GPUContext, with `caps.presentablePassMrt` forced to `false` on request — see
 *  the header for why the stub cannot produce a `false` device directly. */
async function makeCtx(presentablePassMrt: boolean): Promise<GPUContext> {
  const canvas = { width: W, height: H } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  const ctx = (await initGPU(canvas)) as unknown as GPUContext
  if (!presentablePassMrt) {
    ;(ctx.rhi as unknown as { caps: { presentablePassMrt: boolean } }).caps = {
      ...ctx.rhi.caps,
      presentablePassMrt: false,
    }
  }
  return ctx
}

function beginPass(ctx: GPUContext) {
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  return wrapWebGpuPass(encoder.beginRenderPass())
}

/** The last colour-target count `createPipeline` was asked for — see header point 2 for why
 *  "last", not "every", is the non-vacuous, correctly-attributing read for these two
 *  eager-constructor renderers. */
function lastPipelineTargetCount(spy: { mock: { calls: unknown[][] } }, label: string): number {
  const calls = spy.mock.calls as unknown as Array<[{ colorTargets?: ReadonlyArray<unknown> }]>
  expect(
    calls.length,
    `${label}: no pipeline was created — construction/draw never reached the RHI, so this proves nothing`,
  ).toBeGreaterThan(0)
  return calls[calls.length - 1]![0].colorTargets?.length ?? -1
}

/** Drive UnderOccluderRenderer.render() once (globe projType=7, the only projType the
 *  method's own gate accepts, :215) and return the last colour-target count
 *  `createPipeline` was asked for. */
async function underOccluderLastTargetCount(
  picking: boolean,
  presentablePassMrt: boolean,
): Promise<number> {
  QUALITY.picking = picking
  const ctx = await makeCtx(presentablePassMrt)
  const spy = vi.spyOn(ctx.rhi, 'createPipeline')
  const renderer = new UnderOccluderRenderer(ctx.rhi, ctx.format, 1)
  const camera = new Camera(0, 0, 2)
  camera.projType = GLOBE_PROJ_TYPE
  renderer.render(beginPass(ctx), camera, GLOBE_PROJ_TYPE, 0, 0, W, H, DPR)
  return lastPipelineTargetCount(spy, 'UnderOccluderRenderer')
}

/** One resident, non-extruded fill tile — enough for `renderGlobeFills` to bake + draw
 *  (mirrors drape-fill-translate.test.ts's fixture). */
function fillTile(): GPUTile {
  return {
    extruded: false,
    uploadEpoch: 1,
    tileWest: -180,
    tileSouth: 0,
    tileWidth: 90,
    tileHeight: 90,
    tileZoom: 2,
  } as unknown as GPUTile
}

const TILE_KEY = 100

/** Returns a bare object shaped like a raw `GPUTexture` (has `.createView`), so
 *  RasterDraper.viewOf resolves it without touching the RHI's own `createView`. */
const provider: DrapeBakeProvider = {
  bakeTileToTexture: () => ({ createView: () => ({}) }) as unknown as never,
}

/** Drive VectorDrapeRenderer.renderGlobeFills() once with one resident tile and return the
 *  last colour-target count `createPipeline` was asked for. */
async function vectorDrapeLastTargetCount(
  picking: boolean,
  presentablePassMrt: boolean,
): Promise<number> {
  QUALITY.picking = picking
  const ctx = await makeCtx(presentablePassMrt)
  const spy = vi.spyOn(ctx.rhi, 'createPipeline')
  const renderer = new VectorDrapeRenderer(ctx.rhi, ctx.format, 1)
  renderer.beginFrame()
  renderer.renderGlobeFills(
    beginPass(ctx),
    { matrix: new Float32Array(16), logDepthFc: 1 },
    GLOBE_PROJ_TYPE,
    0,
    0,
    { centerX: 0, centerY: 0 },
    1,
    [0.5, 0.5, 0.5, 1],
    0,
    2,
    'land',
    [TILE_KEY],
    undefined,
    new Map([[TILE_KEY, fillTile()]]),
    provider,
  )
  return lastPipelineTargetCount(spy, 'VectorDrapeRenderer')
}

interface Arm {
  picking: boolean
  presentablePassMrt: boolean
  expected: number
}
const ARMS: readonly Arm[] = [
  { picking: true, presentablePassMrt: true, expected: 2 },
  { picking: true, presentablePassMrt: false, expected: 1 }, // the arm that reds pre-fix
  { picking: false, presentablePassMrt: true, expected: 1 },
  { picking: false, presentablePassMrt: false, expected: 1 },
]

describe('under-occluder + globe drape pick pipeline vs pass attachment count (#2571)', () => {
  for (const { picking, presentablePassMrt, expected } of ARMS) {
    const label = `picking=${picking} presentablePassMrt=${presentablePassMrt}`

    it(`UnderOccluderRenderer — ${label} → selected pipeline carries ${expected} target(s)`, async () => {
      expect(await underOccluderLastTargetCount(picking, presentablePassMrt)).toBe(expected)
    })

    it(`VectorDrapeRenderer — ${label} → selected pipeline carries ${expected} target(s)`, async () => {
      expect(await vectorDrapeLastTargetCount(picking, presentablePassMrt)).toBe(expected)
    })
  }
})

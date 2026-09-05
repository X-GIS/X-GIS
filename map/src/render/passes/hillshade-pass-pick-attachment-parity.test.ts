// ═══ Hillshade draw must never ask for the pick pipeline (#2314) ═══
//
// hillshade-pass.ts opens exactly ONE colour attachment, unconditionally
// (`colorAttachments: [{ view: colorView, ... }]`, hillshade-pass.ts:122) — the
// file has zero references to a `pickView`. HillshadeDraper, though, builds a
// TWO-colour-target pipeline (bgra8unorm + rg32uint, hillshade-material.ts:
// 125-127) whenever `draw()` is called with `pick: true`, labelled
// 'hillshade-pick-pipeline-rhi'. Passing the bare `isPickEnabled()` into that
// `pick` argument (the pre-#2314 shape of HillshadeRenderer.render's draw
// call) is a pass/draper attachment-count contract violation the type system
// cannot see: on WebGPU, Dawn rejects every `setPipeline` with
//
//   Attachment state of [RenderPipeline "hillshade-pick-pipeline-rhi"] is not
//   compatible with [RenderPassEncoder]… expects an attachment state of
//   { colorTargets: [0={format:TextureFormat::BGRA8Unorm}] }
//
// which invalidates the frame's whole command buffer — a blank map, with
// picking on, at 100% modal on one colour bucket (measured on
// fixture_hillshade_local). Relief is not pickable anyway — fs_hillshade's
// pick fragment writes vec2u(0,0) under writeMask 0 — so the fix is simply to
// never ask for the twin: HillshadeRenderer.render's draw call now hardcodes
// `false`.
//
// This pins the CONTRACT the fix rests on: the hillshade PASS is the
// authority on how many colour targets a hillshade PIPELINE may carry, and no
// pipeline HillshadeDraper builds may exceed it. Driven over the REAL chain —
// installWebGPUStub + initGPU + HillshadeRenderer, the hillshade-loadtile-rhi
// idiom — spying on `ctx.rhi.createPipeline`, with `QUALITY.picking` both true
// and false so the guard is non-vacuous in EITHER direction: with picking
// off, `isPickEnabled()` already returns false and this gate would stay green
// even reverted, so it is the picking-ON arm that actually pins the
// mechanism; the picking-OFF arm only confirms the fix does not regress the
// ordinary path. Both arms need their own "at least one pipeline was
// created" guard — a draw that never reaches materialFor proves nothing about
// either.
//
// Fail-before: reverting the draw-call argument to `isPickEnabled()` reds the
// picking-ON case below with a 2-target pipeline and this test's own message
// (see CLAUDE.md §5 for the paired before/after run this file was written to
// support).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { Camera, HillshadeRenderer, armHillshadeSource } from '@xgis/map'
import { QUALITY } from '@xgis/engine'

let stub: StubInstallation
const priorFetch = globalThis.fetch

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
  // Tile loads are irrelevant to this gate (materialFor runs whether or not any
  // tile is resident yet) but render() still ISSUES them — a never-resolving
  // fetch keeps this hermetic (no real network) without reaching into
  // DemTileStore internals the way source-scheme-wiring.test.ts's recorderOn
  // does for a different purpose (recording the requested URLs).
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
})
afterEach(() => {
  stub.uninstall()
  globalThis.fetch = priorFetch
})

const origPicking = QUALITY.picking
afterEach(() => {
  QUALITY.picking = origPicking
})

const W = 2000
const H = 800
const DPR = 1
const ZOOM = 1
const PROJ_TYPE = 0

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: W, height: H } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** Mirrors source-scheme-wiring.test.ts's drive() — one synchronous render()
 *  call through the real WebGPU stub. */
function drive(ctx: GPUContext, renderer: { render: (...a: never[]) => void }): void {
  const camera = new Camera(0, 0, ZOOM)
  camera.projType = PROJ_TYPE
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  ;(renderer.render as (...a: unknown[]) => void)(
    wrapWebGpuPass(encoder.beginRenderPass()),
    camera,
    PROJ_TYPE,
    0,
    0,
    W,
    H,
    0,
    DPR,
  )
}

/** One macrotask flush — enough to drain the shader-emit-pool's microtask
 *  chain. Node has no `Worker`, so `requestShaderSources` resolves through
 *  the synchronous main-thread `emitFor` fallback wrapped in one
 *  `Promise.resolve().then()` (seed-hillshade.test.ts:15); a macrotask always
 *  runs after every already-queued microtask, so this is robust regardless of
 *  exactly how many `.then()` layers are in that chain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Arms a DEM source and drives render() until the (memoised, per
 *  methodFlag+pick) hillshade Material has actually been constructed, then
 *  returns every colour-target count `ctx.rhi.createPipeline` was asked for
 *  along the way. The FIRST drive() only ever kicks off the async shader
 *  emit — materialFor's `peekShaderSources` misses, it fires
 *  `requestShaderSources` and returns null, and HillshadeDraper.draw() draws
 *  nothing. The SECOND drive(), after the emit settles, is what finds the
 *  cache hit and actually builds the Material — i.e. actually calls
 *  createPipeline. Zero resident DEM tiles is fine: materialFor runs
 *  regardless of how many tiles the draw list carries (hillshade-material.ts
 *  draw()). */
async function pipelineColorTargetCounts(picking: boolean): Promise<number[]> {
  QUALITY.picking = picking
  const ctx = await makeCtx()
  const renderer = new HillshadeRenderer(ctx)
  armHillshadeSource(renderer, { _tileUrl: 'https://dem.example.com/{z}/{x}/{y}.png' })
  renderer.setParams({ tileSize: 256 })
  const spy = vi.spyOn(ctx.rhi, 'createPipeline')

  drive(ctx, renderer)
  await settle()
  drive(ctx, renderer)

  return spy.mock.calls.map(([desc]) => desc.colorTargets?.length ?? -1)
}

/** Vacuity guard + the shared assertion: every pipeline the draw created must
 *  carry exactly 1 colour target, the one hillshade-pass.ts opens. */
function assertAllSingleTarget(counts: number[]): void {
  expect(
    counts.length,
    'no pipeline was created — the draw never reached materialFor, so this proves nothing',
  ).toBeGreaterThan(0)
  for (const n of counts) {
    expect(
      n,
      `hillshade created a ${n}-target pipeline; the hillshade pass opens 1 colour attachment (#2314)`,
    ).toBe(1)
  }
}

describe('HillshadeRenderer.render draw never asks for the 2-target pick pipeline (#2314)', () => {
  it('picking ON: every pipeline the draw creates still carries exactly 1 colour target', async () => {
    assertAllSingleTarget(await pipelineColorTargetCounts(true))
  })

  it('picking OFF: every pipeline the draw creates carries exactly 1 colour target', async () => {
    assertAllSingleTarget(await pipelineColorTargetCounts(false))
  })
})

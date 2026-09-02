// #2314: hillshade drew a 2-target (pick) pipeline into its 1-attachment pass.
//
// Witness: the hillshade pass opens a render pass with N colour attachments; the
// pipeline HillshadeRenderer selects for that pass must carry exactly N colour targets
// (WebGPU validation: pipeline attachment state must match the pass it is set on).
// Drives the REAL chain — hillshadePass.execute → HillshadeRenderer.render →
// HillshadeDraper.draw → Material → rhi.createPipeline — over the WebGPU stub device,
// recording the pass descriptor on one side and the pipeline descriptor on the other.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { QUALITY } from '@xgis/engine'
import { HillshadeRenderer } from '../hillshade-renderer'
import { hillshadePass } from './hillshade-pass'
import { makeProjectionToken } from '../projection-token'
import { Camera } from '../../camera'
import { seedShaderSources, _resetShaderEmitCache } from '../../shaders/emit/shader-emit-pool'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

let stub: StubInstallation
const origPicking = QUALITY.picking

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
  _resetShaderEmitCache()
  // Sources are already "known" so materialFor() builds the pipeline on the first draw.
  const SRC = { vertex: '', fragment: '', wgsl: '// stub' }
  seedShaderSources({ family: 'hillshade', pick: true, methodFlag: 0 }, SRC)
  seedShaderSources({ family: 'hillshade', pick: false, methodFlag: 0 }, SRC)
})
afterEach(() => {
  QUALITY.picking = origPicking
  stub.uninstall()
  vi.restoreAllMocks()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

async function runFrame(picking: boolean): Promise<{
  passAttachments: number
  pipelineTargets: number[]
}> {
  QUALITY.picking = picking
  const gpu = await makeCtx()
  const pipelineTargets: number[] = []
  const origCreate = gpu.rhi.createPipeline.bind(gpu.rhi)
  vi.spyOn(gpu.rhi, 'createPipeline').mockImplementation((desc) => {
    pipelineTargets.push(desc.colorTargets.length)
    return origCreate(desc)
  })

  const hr = new HillshadeRenderer(gpu)
  hr.setUrlTemplate('https://dem.example.com/{z}/{x}/{y}.png')
  // Never let a tile load touch the network; the draw path does not need a resident tile
  // to select (and build) its pipeline.
  ;(hr as unknown as { loadTileTexture: () => Promise<unknown> }).loadTileTexture = () =>
    new Promise<unknown>(() => {})

  const captured: { desc: { colorAttachments: unknown[] } }[] = []
  const enc = {
    beginRenderPass: (desc: { colorAttachments: unknown[] }) => {
      const p = {
        desc,
        end() {},
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        draw() {},
        drawIndexed() {},
      }
      captured.push(p)
      return p
    },
  }
  const colorView = { __rhiColorView: true }
  const stencilView = { __rhiStencilView: true }
  const sceneResolveView = { __rhiSceneResolveView: true }
  const pickView = picking ? { __rhiPickView: true } : null
  const ctx = {
    rhi: gpu.rhi,
    rhiEncoder: enc,
    rhiScreenView: { __rhiScreenView: true },
    rhiColorView: colorView,
    rhiStencilView: stencilView,
    rhiSceneResolveView: sceneResolveView,
    rhiColorViewScreen: colorView,
    passScope: (_label: string, fn: () => void) => fn(),
    useResolve: false,
    rt: { pickTexture: picking ? {} : null, pickView, stencilView },
    projection: makeProjectionToken(0, 0, 0),
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    _elapsedMs: 0,
  } as unknown as FrameContext
  const camera = new Camera(0, 0, 2)
  camera.projType = 0
  const host = {
    hillshadeRenderer: hr,
    _hillshadeShow: null,
    camera,
    _elapsedMs: 0,
    inputs: null,
  }
  const scene = {
    hasHillshade: true,
    overdraw: false,
    resolveOwner: 'none',
  } as unknown as SceneView

  hillshadePass.execute(ctx, scene, host as never)

  expect(captured, 'the hillshade pass must open exactly one render pass').toHaveLength(1)
  expect(pipelineTargets, 'the draw must have built exactly one hillshade pipeline').toHaveLength(1)
  return { passAttachments: captured[0].desc.colorAttachments.length, pipelineTargets }
}

describe('hillshade pass ↔ hillshade pipeline attachment-state agreement', () => {
  it('picking OFF: one attachment, one colour target (control arm)', async () => {
    const r = await runFrame(false)
    expect(r.passAttachments).toBe(1)
    expect(r.pipelineTargets[0]).toBe(1)
  })

  it('picking ON (WebGPU, presentablePassMrt): the pipeline target count equals the pass attachment count', async () => {
    const r = await runFrame(true)
    expect(
      r.pipelineTargets[0],
      `HillshadeRenderer selected a ${r.pipelineTargets[0]}-target pipeline for a pass the ` +
        `hillshade pass opened with ${r.passAttachments} colour attachment(s) — WebGPU rejects ` +
        `setPipeline (attachment state mismatch) and the whole frame's command buffer is invalid`,
    ).toBe(r.passAttachments)
  })
})

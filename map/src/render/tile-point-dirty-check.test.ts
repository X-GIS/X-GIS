// #1581 leg B — discriminating test for the tile-point dirty-check gate.
//
// Root cause: `PointRenderer.flushTilePointsRhi` reran unconditionally every
// rendered frame — a fresh repack and three `createBuffer('tile-point-*')`
// calls (vertices/index/features) even at a static camera with an unchanged
// tile set and style. `VectorTileRenderer.emitTilePointsRhi` now computes a
// `TilePointPackKey` (stableKeys hash + sliceLayer + paint-affecting `show`
// fields + camera zoom/pitch) and skips straight to
// `PointRenderer.redrawTilePointsCached` — no accumulation, no repack, no
// buffer recreate — when `canSkipTilePointRepack` says the key is unchanged.
//
// This drives the REAL PointRenderer against the WebGPU stub (no GPU) and
// counts `device.createBuffer` calls labelled `tile-point-*`.
//
// Fail-before: this test was run against a build where the VTR call site
// still called `flushTilePointsRhi` unconditionally every frame (no
// `canSkipTilePointRepack` branch) — the static-camera assertion failed
// (buffer count kept climbing by 3 every frame instead of staying flat).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { WebGpuDevice, wrapWebGpuPass } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'
import { lonLatToECEF } from '@xgis/shared'
import { buildTilePointPackKey, hashStableKeys } from './tile-point-pack-key'
import { tileKey } from '@xgis/compiler'

let stub: StubInstallation

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
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

function addPoint(renderer: PointRenderer, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const f = Math.fround
  renderer.addTilePoint(
    f(ecef[0]),
    f(ecef[1]),
    f(ecef[2]),
    ecef[0] - f(ecef[0]),
    ecef[1] - f(ecef[1]),
    ecef[2] - f(ecef[2]),
    0,
    lon,
    lat,
    0,
    0,
    0,
    0,
  )
}

function countTilePointBufferCreates(device: GPUDevice): { count(): number } {
  let n = 0
  const real = device.createBuffer.bind(device)
  ;(device as { createBuffer: typeof device.createBuffer }).createBuffer = (
    desc: GPUBufferDescriptor,
  ) => {
    if (typeof desc.label === 'string' && desc.label.startsWith('tile-point-')) n++
    return real(desc)
  }
  return { count: () => n }
}

describe('tile-point dirty-check gate (#1581 leg B, GPU-free)', () => {
  it('a static camera + unchanged style never rebuilds after the first frame', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    const camera = new Camera(0, 0, 4)
    camera.projType = 0
    const creates = countTilePointBufferCreates(ctx.device as unknown as GPUDevice)

    const show = { fill: '#ff8800', stroke: null, size: 6, opacity: 1 }
    const stableKeys = [1, 2, 3]
    const key = buildTilePointPackKey(
      hashStableKeys(stableKeys),
      'layer',
      show,
      camera.zoom,
      camera.pitch,
      0, // contentGeneration — no tile replaced in this scenario (#1616)
      0b00100, // worldCopyMask — copy 0 only (#1616)
    )

    const encoder = (
      ctx.device as unknown as {
        createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
      }
    ).createCommandEncoder()
    const pass = wrapWebGpuPass(encoder.beginRenderPass())
    const args = {
      pass,
      camera,
      projType: 0,
      projCenterLon: 0,
      projCenterLat: 0,
      canvasWidth: 1024,
      canvasHeight: 768,
      show,
      dpr: 1,
    }

    // Frame 1 — nothing cached yet, must accumulate + repack + build.
    expect(renderer.canSkipTilePointRepack(key)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, key)
    expect(creates.count()).toBe(3)

    // Frames 2..21 — static camera, unchanged style: the VTR call site skips
    // accumulation entirely and redraws from the cached buffers.
    for (let i = 0; i < 20; i++) {
      expect(renderer.canSkipTilePointRepack(key)).toBe(true)
      renderer.redrawTilePointsCached(args)
    }
    expect(creates.count()).toBe(3)

    // CONTROL — a style change must still rebuild (a memo that never
    // recomputes is the opposite bug).
    const changedShow = { ...show, fill: '#0000ff' }
    const key2 = buildTilePointPackKey(
      hashStableKeys(stableKeys),
      'layer',
      changedShow,
      camera.zoom,
      camera.pitch,
      0,
      0b00100,
    )
    expect(renderer.canSkipTilePointRepack(key2)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, changedShow, 1, key2)
    expect(creates.count()).toBe(6)
  })
})

// ═══ A PAN must rebuild the pack — the end-to-end consequence of #1616 S1 ═══
//
// The unit gate in tile-point-pack-key-completeness.test.ts proves the HASH
// discriminates. This proves the consequence that actually matters: the buffers
// are really rebuilt when the visible tile set moves.
//
// It exists because the render gate cited as evidence for the S1 fix
// (`_1581-static-camera-render-gate`) was MEASURED passing 4/4 with the bug fully
// reintroduced. It pans, which reads like coverage, but neither post-pan
// assertion can see this: "pixels changed after setCenter" is satisfied by the
// FILLS moving whether or not the point pack was reused, and "pixels match after
// returning to the origin" is satisfied trivially by a pack that was never
// rebuilt — it is still the origin's pack. A gate that passes identically with
// and without the defect carries no information (2026-07-28 ledger entry).
//
// Fail-before: with `hashStableKeys` restored to its XOR-fold, `panned` below
// equals `atOrigin` for every even-sided rectangle, `canSkipTilePointRepack`
// stays true, and the buffer count never moves off 3.
describe('a pan rebuilds the tile-point pack (#1616 S1, end-to-end)', () => {
  /** The visible tile rectangle at a camera position, as `stableKeys` would hold it. */
  const view = (x0: number, y0: number, W: number, H: number): number[] => {
    const keys: number[] = []
    for (let dy = 0; dy < H; dy++)
      for (let dx = 0; dx < W; dx++) keys.push(tileKey(12, x0 + dx, y0 + dy))
    return keys
  }
  const keyFor = (
    keys: number[],
    show: TilePointShowLike,
  ): ReturnType<typeof buildTilePointPackKey> =>
    buildTilePointPackKey(hashStableKeys(keys), 'layer', show, 4, 0, 0, 0b00100)
  type TilePointShowLike = Parameters<typeof buildTilePointPackKey>[2]

  it('rebuilds the GPU buffers when the visible tile set pans, at a fixed camera pose', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    const camera = new Camera(0, 0, 4)
    camera.projType = 0
    const creates = countTilePointBufferCreates(ctx.device as unknown as GPUDevice)
    const show = { fill: '#ff8800', stroke: null, size: 6, opacity: 1 }
    const encoder = (
      ctx.device as unknown as {
        createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
      }
    ).createCommandEncoder()
    const pass = wrapWebGpuPass(encoder.beginRenderPass())

    // Frame 1 — the view at its origin. 4x4 is the exact shape the XOR-fold
    // cancelled to zero, so this is the discriminating fixture, not an arbitrary one.
    const atOrigin = keyFor(view(100, 200, 4, 4), show)
    expect(renderer.canSkipTilePointRepack(atOrigin)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, atOrigin)
    expect(creates.count()).toBe(3)

    // Frame 2 — same zoom, same pitch, same style: ONLY the tile set moved, by a
    // single tile east. Four of the sixteen tiles are new.
    const panned = keyFor(view(101, 200, 4, 4), show)
    expect(
      renderer.canSkipTilePointRepack(panned),
      'a pan brought new tiles into view — reusing the pack means their points never draw',
    ).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, panned)
    expect(creates.count(), 'the pan must have rebuilt the three tile-point buffers').toBe(6)

    // CONTROL — holding still after the pan must still reuse, or this gate would
    // pass by breaking the memo outright rather than by fixing its key.
    expect(renderer.canSkipTilePointRepack(keyFor(view(101, 200, 4, 4), show))).toBe(true)
    expect(creates.count(), 'no rebuild while the view is unchanged').toBe(6)
  })
})

// icon-anchor: quad-anchor offset wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: icon-anchor is marked
// `supported` (constant, 9-way enum) in runtime/src/capabilities/symbol.ts:72
// + the symbol spec-coverage table, but its RUNTIME wiring was verified only
// structurally (the enum literal converts) — never that the chosen anchor
// actually moves the icon quad's corner in the GPU vertex buffer. A broken
// data path (icon-anchor stops shifting the quad, so every icon renders
// centre-anchored) would ship silently — the heatmap-class bug.
//
// The runtime contract (icon-renderer.ts):
//   IconRenderer.setDraws() computes the quad's TOP-LEFT corner as
//     [ax, ay] = anchorOffset(anchor, drawW, drawH); x0 = anchorX + ax; ...
//   and writes that corner into the icon-vertex buffer's pos_px slot
//   (float slot 0,1 of vertex 0) via device.queue.writeBuffer. anchorOffset:
//     center       -> [-w/2, -h/2]
//     top          -> [-w/2, 0   ]
//     bottom-right -> [-w,   -h   ]
//     top-left     -> [0,     0   ]
// So the captured TL (pos_px.x, pos_px.y) of vertex 0 is a DIRECT,
// prop-dependent function of icon-anchor — non-vacuous.
//
// This drives the REAL IconRenderer.setDraws against the WebGPU stub (no GPU),
// intercepts device.queue.writeBuffer, and reads back the first vertex's
// pos_px to assert the EXACT anchor offset per mode.
//
// Fail-before: replace `anchorOffset(d.anchor ?? 'center', drawW, drawH)` with
// `[0, 0]` (drop the anchor's effect) and the center / bottom-right assertions
// fail — icon-anchor no longer reaches the GPU and the test says so before any
// render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { IconRenderer, type IconDraw, type IconAnchor } from './icon-renderer'
import { WebGpuDevice } from '@xgis/engine'
import type { SpriteAtlasGPU } from './sprite-atlas-gpu'
import type { SpriteInfo } from './sprite-atlas-host'

let stub: StubInstallation

beforeEach(() => { stub = installWebGPUStub() })
afterEach(() => { stub.uninstall() })

// A 40x40 design-px sprite (pixelRatio 1) → drawW = drawH = 40 at sizeScale 1.
// Even dims keep every anchorOffset integer so the pixel-snap (Math.round on
// the un-rotated path) is the identity and the assertions are exact.
const SPRITE: SpriteInfo = {
  name: 'test-icon', x: 0, y: 0, width: 40, height: 40, pixelRatio: 1, sdf: false,
} as SpriteInfo

const ANCHOR_X = 200
const ANCHOR_Y = 100
const DRAW_W = 40
const DRAW_H = 40
// pos_px is the first vertex field (location 0, offset 0) → float slots 0,1.
const POS_X_SLOT = 0
const POS_Y_SLOT = 1
// One icon = 6 verts × 9 floats = 54 floats = 216 bytes uploaded.
const VERT_BYTES = 6 * 9 * 4

// Minimal SpriteAtlasGPU stand-in: setDraws only reads atlas.size() (must be
// non-zero so the UV path proceeds). The constructor stores it untouched; all
// GPU object creation goes through the stub device.
const ATLAS = { size: () => ({ width: 256, height: 256 }) } as unknown as SpriteAtlasGPU

/** Resolve the stub GPUDevice (mirrors initGPU's adapter→device hop). */
async function stubDevice(): Promise<GPUDevice> {
  const gpu = (globalThis as unknown as { navigator: { gpu: GPU } }).navigator.gpu
  const adapter = await gpu.requestAdapter()
  return (await adapter!.requestDevice()) as GPUDevice
}

async function topLeftFor(anchor: IconAnchor): Promise<[number, number]> {
  const device = await stubDevice()
  const renderer = new IconRenderer(device, new WebGpuDevice(device), ATLAS, 'bgra8unorm', 1)

  let tl: [number, number] | null = null
  const dev = device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown, bufOff: number,
        data: ArrayBufferView | ArrayBuffer, dataOff?: number, size?: number,
      ) => void
    }
  }
  dev.queue.writeBuffer = (
    buf: unknown, _bufOff: number,
    data: ArrayBufferView | ArrayBuffer, dataOff = 0, size?: number,
  ): void => {
    // The vertex buffer is the large (>=1024 B) one; the uniform write (16 B)
    // only fires in draw(), which we never call. Read vertex 0's pos_px.
    if ((buf as { size?: number })?.size === undefined || (buf as { size?: number }).size! < 1024) return
    const ab = data instanceof ArrayBuffer ? data : data.buffer
    const byteOff = data instanceof ArrayBuffer ? dataOff : (data as ArrayBufferView).byteOffset + dataOff
    const f32 = new Float32Array(ab, byteOff, (size ?? VERT_BYTES) / 4)
    tl = [f32[POS_X_SLOT]!, f32[POS_Y_SLOT]!]
  }

  const draw: IconDraw = {
    anchorX: ANCHOR_X, anchorY: ANCHOR_Y,
    sprite: SPRITE, sizeScale: 1, rotateRad: 0, anchor,
  }
  renderer.setDraws([draw])

  expect(tl, 'icon-vertex buffer should have been written').not.toBeNull()
  return tl!
}

describe('icon-anchor quad-offset wiring (GPU-free)', () => {
  it('center → top-left corner = (anchorX - w/2, anchorY - h/2)', async () => {
    expect(await topLeftFor('center')).toEqual([ANCHOR_X - DRAW_W / 2, ANCHOR_Y - DRAW_H / 2])
  })

  it('top-left → top-left corner = (anchorX, anchorY)', async () => {
    expect(await topLeftFor('top-left')).toEqual([ANCHOR_X, ANCHOR_Y])
  })

  it('bottom-right → top-left corner = (anchorX - w, anchorY - h)', async () => {
    expect(await topLeftFor('bottom-right')).toEqual([ANCHOR_X - DRAW_W, ANCHOR_Y - DRAW_H])
  })

  it('top → top-left corner = (anchorX - w/2, anchorY) — y unshifted', async () => {
    expect(await topLeftFor('top')).toEqual([ANCHOR_X - DRAW_W / 2, ANCHOR_Y])
  })

  it('anchor distinguishes corners — center ≠ top-left ≠ bottom-right', async () => {
    const c = await topLeftFor('center')
    const tl = await topLeftFor('top-left')
    const br = await topLeftFor('bottom-right')
    expect(c).not.toEqual(tl)
    expect(c).not.toEqual(br)
    expect(tl).not.toEqual(br)
  })
})

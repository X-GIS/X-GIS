// icon-size / icon-opacity: per-vertex packer wiring (GPU-free, fail-before).
//
// #777 cluster I-F closes the DATA-DRIVEN icon-size / icon-opacity value-forms.
// The per-feature evaluate-then-dispatch (applyFeatureExprs, label-pass.ts)
// resolves the expression to a scalar `sizeScale` / `opacity` on the IconDraw;
// this test pins the FINAL hop — that IconRenderer.setDraws (the packer) stamps
// those scalars into the vertex bytes the GPU reads:
//   • icon-opacity → the per-vertex `opacity` slot (float 4 of a 9-float vertex),
//     identical on every vertex of the quad.
//   • icon-size → the quad WIDTH (BR.x − TL.x = designW × sizeScale); a per-
//     feature `["match"]`-driven size renders a wider/narrower quad.
// (The compiler → data-driven-shape → evaluate half is pinned by
//  icon-value-forms-wiring.test.ts; the zoom-interp opacity resolve + the
//  data-driven fall-through by render-loop-helpers-icon-opacity-zoom.test.ts.)
//
// Drives the REAL IconRenderer.setDraws against the WebGPU stub (no GPU) and
// intercepts device.queue.writeBuffer to read the uploaded per-vertex floats.
//
// Fail-before (opacity): replace `const op = d.opacity ?? 1` with `const op = 1`
// (icon-renderer.ts) → the opacity-slot assertion fails (reads 1, not 0.35).
// Fail-before (size): replace `const drawW = designW * d.sizeScale` with
// `const drawW = designW` → the width assertion fails (reads 16, not 40).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { IconRenderer, type IconDraw } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { ICON_FORMAT } from '@xgis/map'
import { vertexField } from '@xgis/compiler'
import type { SpriteInfo } from '@xgis/map'

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

// Derived from the single-source ICON_FORMAT so the test cannot drift from the
// packer. 9 floats/vert; pos.xy at 0,1; opacity at 4. 6 verts = 54 floats/quad.
const FLOATS_PER_VERT = ICON_FORMAT.stride / 4 // 9
const PX_SLOT = vertexField(ICON_FORMAT, 'pos_px').offset / 4 // 0
const OPACITY_SLOT = vertexField(ICON_FORMAT, 'opacity').offset / 4 // 4
const FLOATS_PER_QUAD = FLOATS_PER_VERT * 6 // 54
const VERTEX_BUF_BYTES = 1024

// 16px design sprite (pixelRatio 1) → designW = 16. A non-1, non-trivial size
// so the assertion is non-vacuous (a dropped-scale break renders 16, not 40).
const SPRITE: SpriteInfo = {
  name: 'marker',
  x: 0,
  y: 0,
  width: 16,
  height: 16,
  pixelRatio: 1,
  sdf: false,
}
const DESIGN_W = SPRITE.width / SPRITE.pixelRatio // 16
const FAKE_ATLAS = { size: () => ({ width: 256, height: 256 }) }

/** Build a real IconRenderer against the stub, run setDraws once, return the
 *  captured first quad (54 floats) from the vertex-buffer writeBuffer. */
function capturedQuad(ctx: GPUContext, draw: IconDraw): Float32Array | undefined {
  const renderer = new IconRenderer(
    ctx.device,
    new WebGpuDevice(ctx.device),
    FAKE_ATLAS as never,
    ctx.format,
    1,
  )
  let quad: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown,
        bufOff: number,
        data: ArrayBufferView | ArrayBuffer,
        dataOff?: number,
        size?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _bufOff: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOff?: number,
    _size?: number,
  ): void => {
    if ((buf as { size?: number })?.size !== VERTEX_BUF_BYTES) return
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const baseOff =
      data instanceof ArrayBuffer ? (dataOff ?? 0) : (data as ArrayBufferView).byteOffset
    quad = new Float32Array(ab, baseOff, FLOATS_PER_QUAD)
  }
  renderer.setDraws([draw])
  return quad
}

const BASE: IconDraw = { anchorX: 100, anchorY: 200, sprite: SPRITE, sizeScale: 1 }

describe('icon-size / icon-opacity per-vertex packer wiring (GPU-free, #777 I-F)', () => {
  it('icon-opacity stamps the per-vertex opacity slot on every vertex', async () => {
    const ctx = await makeCtx()
    const q = capturedQuad(ctx, { ...BASE, opacity: 0.35 })
    expect(q, 'icon vertex buffer (1024 B) should have been written').toBeTruthy()
    for (let v = 0; v < 6; v++) {
      expect(q![v * FLOATS_PER_VERT + OPACITY_SLOT]).toBeCloseTo(0.35, 6)
    }
  })

  it('omitted icon-opacity defaults to 1 (byte-identical no-fade)', async () => {
    const ctx = await makeCtx()
    const q = capturedQuad(ctx, { ...BASE })
    expect(q![OPACITY_SLOT]).toBe(1)
  })

  it('icon-size scales the quad width (BR.x − TL.x = designW × sizeScale)', async () => {
    const ctx = await makeCtx()
    // sizeScale 2.5 → width 40; sizeScale 1 → width 16. The value drives the
    // per-vertex geometry — a data-driven ["match"] size renders per-feature.
    const big = capturedQuad(ctx, { ...BASE, sizeScale: 2.5 })
    const tlx = big![0 * FLOATS_PER_VERT + PX_SLOT]
    const brx = big![2 * FLOATS_PER_VERT + PX_SLOT] // vertex 2 = BR
    expect(brx - tlx).toBeCloseTo(DESIGN_W * 2.5, 6) // 40
    const one = capturedQuad(ctx, { ...BASE, sizeScale: 1 })
    expect(one![2 * FLOATS_PER_VERT + PX_SLOT] - one![0 * FLOATS_PER_VERT + PX_SLOT]).toBeCloseTo(
      DESIGN_W,
      6,
    ) // 16 — the negative control pins the value dependence
  })
})

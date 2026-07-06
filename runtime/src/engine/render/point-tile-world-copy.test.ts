// Tile-point world-copy fan-out — discriminating test for #17 / issue #722 S1.
//
// Root cause: PointRenderer.flushTilePoints hardcoded `COPIES = [0]`, so
// tile / PMTiles point layers only ever rendered in the PRIMARY world — while
// fills, lines and labels replicate to every visible flat-Mercator world copy
// (camera.getVisibleWorldCopies) at low zoom. Tile points therefore vanished
// from the repeated worlds.
//
// Fix (S1): flushTilePoints routes the tile record through the shared stateless
// packer's world-copy fan-out — `pointWorldCopies(projType, camera, …)` — the
// SAME authority the inline GeoJSON path (render()) already uses. The tile
// point's pre-split ECEF + abs lon/lat are copy-independent; only Mercator-x is
// re-split per copy (mercXForCopy → worldCopyMercX parity).
//
// This drives the REAL PointRenderer.flushTilePoints against the WebGPU stub
// (no GPU) at a LOW-zoom, wide-canvas flat-Mercator camera, and intercepts
// `device.queue.writeBuffer` to read the per-feature (feat_data) buffer the
// renderer uploads. It asserts N × copies.length records with the correct
// per-copy Mercator-x offset.
//
// Fail-before: revert flushTilePoints to `COPIES = [0]` and the uploaded
// feat_data buffer holds only N records (size N × STRIDE × 4), never the
// expected N × copies.length size — so the size-keyed capture never fires and
// `feat` stays undefined, failing the first assertion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { pointWorldCopies } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/engine'

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

const DEG2RAD = Math.PI / 180
const R_MERC = 6378137
const WORLD_WIDTH = 360 * DEG2RAD * R_MERC
const STRIDE = 24

// Wide canvas + low zoom so the viewport spans several flat-Mercator worlds.
const W = 4096
const H = 512
const ZOOM = 1

// Three known tile points. Distinct lon/lat so the per-copy Mercator-x
// assertion is unambiguous.
const POINTS: [number, number][] = [
  [10, 30],
  [-73.5, 40],
  [126.977, 37.5],
]
const N = POINTS.length

function split(x: number): [number, number] {
  const h = Math.fround(x)
  return [h, Math.fround(x - h)]
}

/** Push a point into the renderer's tile-point accumulator with the compiler's
 *  pre-split DSFUN (ECEF + abs lon/lat + absolute-Mercator hi/lo). */
function addPoint(renderer: PointRenderer, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const [exH, exL] = split(ecef[0])
  const [eyH, eyL] = split(ecef[1])
  const [ezH, ezL] = split(ecef[2])
  const mx = lon * DEG2RAD * R_MERC
  const myC = Math.max(-85.051129, Math.min(85.051129, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (myC * DEG2RAD) / 2)) * R_MERC
  const [mxH, mxL] = split(mx)
  const [myH, myL] = split(my)
  renderer.addTilePoint(exH, eyH, ezH, exL, eyL, ezL, 0, lon, lat, mxH, mxL, myH, myL)
}

interface Captured {
  feat?: Float32Array
}

describe('tile-point world-copy fan-out (#17 / #722 S1, GPU-free)', () => {
  it('flushTilePoints emits N × copies.length records with per-copy Mercator-x offset', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })

    const camera = new Camera(0, 0, ZOOM)
    camera.projType = 0

    // Sanity: this scenario actually spans multiple world copies (else the
    // test is vacuous). Mirrors point-world-copy.test.ts.
    const copies = pointWorldCopies(0, camera, W, H, 1)
    expect(copies.length, 'low-zoom wide canvas should span >1 world copy').toBeGreaterThan(1)

    const expectedTotalN = N * copies.length
    const FEAT_BYTES = expectedTotalN * STRIDE * 4

    for (const [lon, lat] of POINTS) addPoint(renderer, lon, lat)

    // Capture the per-feature (feat_data) upload, keyed on the FANNED-OUT byte
    // size. On the old COPIES=[0] path this size is never written (only N
    // records), so the capture never fires — the fail-before signal.
    const captured: Captured = {}
    const device = ctx.device as unknown as {
      queue: {
        writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void
      }
    }
    device.queue.writeBuffer = (
      buf: unknown,
      _off: number,
      data: ArrayBufferView | ArrayBuffer,
    ): void => {
      if ((buf as { size?: number })?.size !== FEAT_BYTES) return
      const f32 =
        data instanceof ArrayBuffer
          ? new Float32Array(data)
          : new Float32Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              expectedTotalN * STRIDE,
            )
      captured.feat = f32.slice(0, expectedTotalN * STRIDE)
    }

    const encoder = (
      ctx.device as unknown as {
        createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
      }
    ).createCommandEncoder()
    const pass = encoder.beginRenderPass()
    renderer.flushTilePoints(
      pass,
      camera,
      0,
      0,
      0,
      W,
      H,
      { fill: '#ff8800', stroke: null, size: 6, opacity: 1 },
      1,
    )

    // Fail-before: with COPIES=[0] the fanned-out buffer is never written.
    expect(
      captured.feat,
      'fanned-out feat_data buffer (N × copies × STRIDE) should have been written',
    ).toBeTruthy()
    const feat = captured.feat!
    expect(feat.length).toBe(expectedTotalN * STRIDE)

    // Per-copy Mercator-x offset (point 0 across all copies): reconstruct the
    // absolute-Mercator-x DSFUN (slots 20+21) at globalIdx = w*N. Sorted, the
    // copies must be one world-width apart (they are consecutive world repeats).
    const mxByCopy: number[] = []
    for (let w = 0; w < copies.length; w++) {
      const base = (w * N + 0) * STRIDE
      mxByCopy.push(feat[base + 20] + feat[base + 21])
    }
    const sorted = [...mxByCopy].sort((a, b) => a - b)
    for (let k = 1; k < sorted.length; k++) {
      expect(sorted[k] - sorted[k - 1]).toBeCloseTo(WORLD_WIDTH, 0)
    }

    // The primary copy (wo=0) must land at plain merc(lon0) — proves the offset
    // is applied relative to the true position, not an arbitrary base.
    const merc0 = POINTS[0][0] * DEG2RAD * R_MERC
    const nearestToPrimary = mxByCopy.reduce(
      (best, v) => (Math.abs(v - merc0) < Math.abs(best - merc0) ? v : best),
      mxByCopy[0],
    )
    expect(nearestToPrimary).toBeCloseTo(merc0, 0)

    // ECEF (slots 11-16) + abs lon/lat (17-18) are copy-INDEPENDENT: every
    // copy of point 0 carries the primary point's absolute position unchanged.
    const p0 = lonLatToECEF(POINTS[0][0], POINTS[0][1])
    const [exH0] = split(p0[0])
    for (let w = 0; w < copies.length; w++) {
      const base = (w * N + 0) * STRIDE
      expect(feat[base + 11]).toBe(exH0)
      expect(feat[base + 17]).toBe(Math.fround(POINTS[0][0]))
      expect(feat[base + 18]).toBe(Math.fround(POINTS[0][1]))
    }
  })
})

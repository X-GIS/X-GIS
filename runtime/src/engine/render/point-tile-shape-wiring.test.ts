// Tile-point shape_id wiring — discriminating test for #16 / issue #722 S2.
//
// Root cause: PointRenderer.flushTilePoints hardcoded the per-feature paint
// record's shape_id slot (19) to 0 (circle) — so tile / PMTiles / URL-geojson
// point layers that authored a custom shape (`star`, `cross`, …) ALWAYS drew as
// circles. The INLINE GeoJSON path resolves it (map.ts:2715 →
// this.shapeRegistry.getShapeId(show.shape)), but the tile path never read
// show.shape. Demos custom_shapes / shape_gallery (URL geojson → tile path) and
// fixture_shape_custom_svg surfaced this.
//
// Fix (S2): flushTilePoints resolves show.shape ONCE via the attached
// ShapeRegistry (mirror of map.ts:2715) and writes that id into slot 19 of the
// per-source paint record; the stateless packer copies slot 19 verbatim into
// every fanned-out per-instance record. The point VS/FS dispatches on slot 19
// (point.ts: shape_id==0 → analytical circle, else sdf_shape(shape_id-1)).
//
// This drives the REAL PointRenderer.flushTilePoints against the WebGPU stub
// (no GPU) with a `show` carrying `shape:'star'` and a real ShapeRegistry
// attached, and intercepts `device.queue.writeBuffer` to read the per-feature
// (feat_data) buffer the renderer uploads. It asserts slot 19 == getShapeId
// ('star') (> 0), not the hardcoded 0.
//
// Fail-before: revert flushTilePoints to `src[so + 19] = 0` and slot 19 reads
// back 0 — the assertion (`> 0` and `=== getShapeId('star')`) fails, before any
// render. The negative control (no shape → slot 19 stays 0) proves the assertion
// tracks the PROP, not a constant.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { PointRenderer } from './point-renderer'
import { pointWorldCopies } from './point-renderer'
import { WebGpuDevice } from '@xgis/engine'
import { Camera } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/engine'
import { ShapeRegistry } from '@xgis/map'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const DEG2RAD = Math.PI / 180
const R_MERC = 6378137
const STRIDE = 24
const SHAPE_SLOT = 19 // feat_data slot 19 = shape_id (0 = circle)

// High zoom + normal canvas so the flat-Mercator viewport spans a SINGLE world
// copy (feat_data = N × STRIDE × 4 = 96 bytes for one point — distinct from the
// uniform / vertex / index buffers the renderer also writes).
const W = 1024
const H = 768
const ZOOM = 10

// One tile point. shape_id is per-LAYER (same across all instances), so a single
// point is enough to assert the wiring.
const LON = 10
const LAT = 20

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
  const my = Math.log(Math.tan(Math.PI / 4 + myC * DEG2RAD / 2)) * R_MERC
  const [mxH, mxL] = split(mx)
  const [myH, myL] = split(my)
  renderer.addTilePoint(exH, eyH, ezH, exL, eyL, ezL, 0, lon, lat, mxH, mxL, myH, myL)
}

/** Drive a single tile-point flush with the given `show` (and an attached
 *  ShapeRegistry) and return feat_data slot 19 from the per-feature buffer the
 *  renderer actually uploads. */
function capturedShapeSlot(
  ctx: GPUContext,
  show: { fill?: string | null; stroke?: string | null; size?: number | null; opacity?: number; shape?: string | null },
): { slot19: number; starId: number } {
  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format, rhi: new WebGpuDevice(ctx.device) })
  const registry = new ShapeRegistry(new WebGpuDevice(ctx.device))
  renderer.setShapeRegistry(registry)
  const starId = registry.getShapeId('star')

  const camera = new Camera(LON, LAT, ZOOM)
  camera.projType = 0

  // Single world copy at this zoom → feat_data byte size is unambiguous.
  const copies = pointWorldCopies(0, camera, W, H, 1)
  const totalN = 1 * copies.length
  const FEAT_BYTES = totalN * STRIDE * 4

  addPoint(renderer, LON, LAT)

  let slot19 = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== FEAT_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, totalN * STRIDE)
    slot19 = f32[SHAPE_SLOT] // globalIdx 0
  }

  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.flushTilePoints(pass, camera, 0, LON, LAT, W, H, show, 1)

  return { slot19, starId }
}

describe('tile-point shape_id feat_data slot-19 wiring (#16 / #722 S2, GPU-free)', () => {
  it('feat_data slot 19 carries the resolved shape id (star), not hardcoded circle 0', async () => {
    const ctx = await makeCtx()
    // Fail-before: with `src[so + 19] = 0` this reads 0, failing both asserts.
    const { slot19, starId } = capturedShapeSlot(ctx, { fill: '#ff8800', stroke: null, size: 6, opacity: 1, shape: 'star' })
    expect(starId, 'built-in star must have a non-circle id').toBeGreaterThan(0)
    expect(slot19).toBe(starId)
  })

  it('slot 19 tracks the prop (no shape → circle 0)', async () => {
    const ctx = await makeCtx()
    // Negative control: assertion is non-vacuous — slot 19 is NOT always the
    // star id. A layer with no shape stays a circle (0).
    const { slot19 } = capturedShapeSlot(ctx, { fill: '#ff8800', stroke: null, size: 6, opacity: 1, shape: null })
    expect(slot19).toBe(0)
  })
})

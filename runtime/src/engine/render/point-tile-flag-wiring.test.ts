// Tile-point flag-byte wiring — discriminating test for #722 S3.
//
// Root cause: PointRenderer.flushTilePoints built the per-feature paint record's
// flags slot (10) with ONLY fill(1)/stroke(2). It omitted the size-unit bits
// (4-7), the anchor bits (8-9) and the billboard/flat bit (3) that the INLINE
// GeoJSON path (point-renderer.ts:591-598 in addLayer) already sets. So tile /
// PMTiles / URL-geojson point layers were ALWAYS center-anchored, ALWAYS
// pixel-sized (metric/geographic sizes collapsed to px) and ALWAYS billboarded.
//
// Fix (S3): flushTilePoints mirrors the inline flag byte exactly, threading
// show.sizeUnit / show.anchor / show.billboard into slot 10 with the SAME
// encoding the point shader (map/src/shaders/dsl/point.ts) unpacks: bits 4-7 =
// size_mode, bit 3 = flat, bits 8-9 = anchor. The stateless packer copies slots
// 0-10 verbatim into every fanned-out per-instance record.
//
// This drives the REAL PointRenderer.flushTilePoints against the WebGPU stub (no
// GPU) with a `show` carrying `anchor:'bottom'` + `sizeUnit:'m'` and intercepts
// `device.queue.writeBuffer` to read the per-feature (feat_data) buffer the
// renderer uploads. It asserts slot 10's anchor bits == 1 (bottom) and size-mode
// bits == 1 (m), not the old fill/stroke-only byte.
//
// Fail-before: with the old `let flags = 0; if (fill) flags |= 1; if (stroke)
// flags |= 2`, the anchor/size bits read back 0 — the assertions fail, before any
// render. The default-show control (center / px / billboard) proves the byte is
// UNCHANGED for the DC=0 case (only fill/stroke bits set).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { PointRenderer } from '@xgis/map'
import { pointWorldCopies } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import { Camera } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/engine'

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
const FLAGS_SLOT = 10 // feat_data slot 10 = packed flags

// High zoom + normal canvas so the flat-Mercator viewport spans a SINGLE world
// copy (feat_data = N × STRIDE × 4 = 96 bytes for one point — distinct from the
// uniform / vertex / index buffers the renderer also writes).
const W = 1024
const H = 768
const ZOOM = 10
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

/** Drive a single tile-point flush with the given `show` and return feat_data
 *  slot 10 (the packed flags) from the per-feature buffer the renderer uploads. */
function capturedFlags(
  ctx: GPUContext,
  show: {
    fill?: string | null; stroke?: string | null; size?: number | null; opacity?: number
    sizeUnit?: string | null; anchor?: 'center' | 'bottom' | 'top'; billboard?: boolean
  },
): number {
  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format, rhi: new WebGpuDevice(ctx.device) })

  const camera = new Camera(LON, LAT, ZOOM)
  camera.projType = 0

  const copies = pointWorldCopies(0, camera, W, H, 1)
  const totalN = 1 * copies.length
  const FEAT_BYTES = totalN * STRIDE * 4

  addPoint(renderer, LON, LAT)

  let flags = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== FEAT_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, totalN * STRIDE)
    flags = f32[FLAGS_SLOT] // globalIdx 0
  }

  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.flushTilePoints(pass, camera, 0, LON, LAT, W, H, show, 1)

  return flags
}

describe('tile-point flag feat_data slot-10 wiring (#722 S3, GPU-free)', () => {
  it('slot 10 carries the anchor (bits 8-9) and size-unit (bits 4-7) from show', async () => {
    const ctx = await makeCtx()
    // Fail-before: with fill/stroke-only flags the anchor/size bits read back 0.
    const flags = capturedFlags(ctx, {
      fill: '#ff8800', stroke: null, size: 6, opacity: 1,
      anchor: 'bottom', sizeUnit: 'm',
    })
    const anchorBits = (flags >>> 8) & 3
    const sizeBits = (flags >>> 4) & 0xf
    expect(anchorBits, 'anchor bottom → anchor bits == 1').toBe(1)
    expect(sizeBits, "sizeUnit 'm' → size-mode bits == 1").toBe(1)
    // fill bit still set — the S3 change is additive, not a replacement.
    expect(flags & 1, 'fill bit preserved').toBe(1)
  })

  it('default show (center / px / billboard) leaves the byte unchanged (DC=0)', async () => {
    const ctx = await makeCtx()
    // Positive control: the exact bit pattern circle/default demos ship — only
    // fill/stroke bits, no anchor/size/flat bits. Guards the "stay DC=0" invariant.
    const flags = capturedFlags(ctx, { fill: '#ff8800', stroke: null, size: 6, opacity: 1 })
    expect(flags & 1, 'fill bit set').toBe(1)
    expect(flags & 2, 'no stroke → stroke bit clear').toBe(0)
    expect(flags & 8, 'billboard default → flat bit clear').toBe(0)
    expect((flags >>> 4) & 0xf, 'px default → size-mode bits 0').toBe(0)
    expect((flags >>> 8) & 3, 'center default → anchor bits 0').toBe(0)
  })
})

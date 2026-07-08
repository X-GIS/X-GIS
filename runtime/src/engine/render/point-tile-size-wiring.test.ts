// Tile-point data-driven SIZE wiring — discriminating test for #17 / issue #722 S4.
//
// Root cause: PointRenderer.flushTilePoints wrote ONE radius to every point —
// `src[so + 0] = show.size ?? 6` — so a data-driven size expression (e.g.
// gradient_points' `size-[sqrt(.pop_max)/120]`) collapsed to a constant on the
// tile / PMTiles / URL-geojson point path. The INLINE GeoJSON path resolves it
// per feature (map.ts:2688-2711 → evaluate(sizeExpr.ast, makeEvalProps(props))),
// but the tile path never evaluated the expression against per-feature props.
//
// Fix (S4): flushTilePoints evaluates `show.sizeExpr` per feature against that
// feature's SOURCE properties — threaded onto each accumulated tile point as
// `pt.featProps` (featureProps.get(fid) resolved per-tile in the VTR, because
// fid == source-feature index WITHIN a tile and collides across tiles). Same
// @xgis/compiler evaluate + makeEvalProps + throw-isolation → numeric fallback
// the inline path uses. The written feat_data slot 0 (radius_px) then carries
// the per-feature size, not the constant.
//
// This drives the REAL PointRenderer.flushTilePoints against the WebGPU stub
// (no GPU) with three points of DISTINCT fids + a featureProps map giving them
// different `pop` values + a data-driven `size-[.pop]` expression, and
// intercepts `device.queue.writeBuffer` to read the per-feature (feat_data)
// buffer the renderer uploads. It asserts slot 0 DIFFERS per point (== the
// evaluated `.pop`), not the uniform `show.size ?? 6`.
//
// Fail-before: with `src[so + 0] = radiusPx` for every point, slot 0 reads back
// the constant 6 for all three points — the "differs per point" assertion fails
// before any render. The negative control (no sizeExpr → constant size) proves
// the assertion tracks the EXPRESSION, not just any per-point write, and pins
// the byte-identical constant-size path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { pointWorldCopies } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'
import { lonLatToECEF } from '@xgis/shared'

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
const STRIDE = 24
const RADIUS_SLOT = 0 // feat_data slot 0 = radius_px

// High zoom + normal canvas so the flat-Mercator viewport spans a SINGLE world
// copy → feat_data byte size is unambiguous (N × STRIDE × 4).
const W = 1024
const H = 768
const ZOOM = 10
const LON = 10
const LAT = 20

// `size-[.pop]` — a data-driven size that reads the numeric `pop` property.
// FieldAccess(object:null) is the `.pop` implicit-current-data form the parser
// emits; evaluate() returns props['pop'].
const SIZE_POP_EXPR = { ast: { kind: 'FieldAccess', object: null, field: 'pop' } as unknown }

function split(x: number): [number, number] {
  const h = Math.fround(x)
  return [h, Math.fround(x - h)]
}

/** Push a point into the renderer's tile-point accumulator with the compiler's
 *  pre-split DSFUN + a distinct fid and (optionally) its source props. */
function addPoint(
  renderer: PointRenderer,
  lon: number,
  lat: number,
  featId: number,
  featProps: Record<string, unknown> | null,
): void {
  const ecef = lonLatToECEF(lon, lat)
  const [exH, exL] = split(ecef[0])
  const [eyH, eyL] = split(ecef[1])
  const [ezH, ezL] = split(ecef[2])
  const mx = lon * DEG2RAD * R_MERC
  const myC = Math.max(-85.051129, Math.min(85.051129, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (myC * DEG2RAD) / 2)) * R_MERC
  const [mxH, mxL] = split(mx)
  const [myH, myL] = split(my)
  renderer.addTilePoint(
    exH,
    eyH,
    ezH,
    exL,
    eyL,
    ezL,
    featId,
    lon,
    lat,
    mxH,
    mxL,
    myH,
    myL,
    featProps,
  )
}

/** Drive a single tile-point flush with three DISTINCT-fid points + a
 *  featureProps map, and return feat_data slot 0 (radius_px) for each of the
 *  three points from the per-feature buffer the renderer actually uploads. */
function capturedRadiusSlots(
  ctx: GPUContext,
  show: {
    fill?: string | null
    stroke?: string | null
    size?: number | null
    opacity?: number
    sizeExpr?: { ast?: unknown } | null
  },
  featureProps: Map<number, Record<string, unknown>> | null,
): number[] {
  const renderer = new PointRenderer({
    device: ctx.device,
    format: ctx.format,
    rhi: new WebGpuDevice(ctx.device),
  })

  const camera = new Camera(LON, LAT, ZOOM)
  camera.projType = 0

  const N = 3
  const copies = pointWorldCopies(0, camera, W, H, 1)
  const totalN = N * copies.length
  const FEAT_BYTES = totalN * STRIDE * 4

  // Three points, distinct fids, distinct props (pop = 100 / 400 / 900).
  for (let i = 0; i < N; i++) {
    addPoint(renderer, LON + i * 0.01, LAT, i, featureProps ? (featureProps.get(i) ?? null) : null)
  }

  let slots: number[] = []
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
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
            totalN * STRIDE,
          )
    slots = [
      f32[0 * STRIDE + RADIUS_SLOT],
      f32[1 * STRIDE + RADIUS_SLOT],
      f32[2 * STRIDE + RADIUS_SLOT],
    ]
  }

  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.flushTilePoints(pass, camera, 0, LON, LAT, W, H, show, 1)

  return slots
}

describe('tile-point data-driven size feat_data slot-0 wiring (#17 / #722 S4, GPU-free)', () => {
  it('feat_data slot 0 carries the per-feature evaluated size, not the constant show.size', async () => {
    const ctx = await makeCtx()
    const featureProps = new Map<number, Record<string, unknown>>([
      [0, { pop: 100 }],
      [1, { pop: 400 }],
      [2, { pop: 900 }],
    ])
    // Fail-before: with `src[so + 0] = radiusPx` all three read back 6 (== size),
    // so both the "== .pop" and the "differ per point" asserts fail.
    const slots = capturedRadiusSlots(
      ctx,
      { fill: '#ff8800', stroke: null, size: 6, opacity: 1, sizeExpr: SIZE_POP_EXPR },
      featureProps,
    )
    expect(slots[0]).toBeCloseTo(100, 5)
    expect(slots[1]).toBeCloseTo(400, 5)
    expect(slots[2]).toBeCloseTo(900, 5)
    // Non-vacuous: the three sizes are genuinely distinct (was uniform pre-S4).
    expect(new Set(slots).size).toBe(3)
  })

  it('constant size (no sizeExpr) stays uniform at show.size — byte-identical path', async () => {
    const ctx = await makeCtx()
    // Negative control: without a size expression every point keeps show.size,
    // proving the per-feature write is gated on the EXPRESSION (constant-size
    // path unchanged / DC=0).
    const slots = capturedRadiusSlots(
      ctx,
      { fill: '#ff8800', stroke: null, size: 6, opacity: 1, sizeExpr: null },
      null,
    )
    expect(slots).toEqual([6, 6, 6])
  })
})

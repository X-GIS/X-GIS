// Pin the flat-Mercator raster world-copy fan-out to a SINGLE source.
//
// Bug (fix/raster-world-copy-double-draw): for flat Mercator (projType 0)
// world copies were enumerated TWICE.
//
//   1. `visibleTilesFrustum` is called with the mercator selector, whose
//      `worldCopiesFor(0)` is the full WORLD_COPIES set [-2..2]. The DFS
//      visits each copy `visit(0,0,0,k)` and bakes the copy offset into the
//      tile's `ox`, so the bounds the renderer derives from `ox`
//      (`west = ox/rn*360 - 180`, raster-renderer ~329) ALREADY sit in their
//      own world copy.
//   2. The renderer then ALSO looped `RASTER_WORLD_COPIES`
//      (= camera.getVisibleWorldCopies for projType<0.5) and shifted bounds
//      AGAIN by `wo*360` (raster-renderer ~390: `tf[0] = west + wo*360`).
//
// Net: a tile selected in copy k was drawn at every world position k+wo, so
// the same logical world tile got rasterised multiple times at the same
// screen location at low zoom. With raster-opacity<1 the BLEND_ALPHA
// composite COMPOUNDED (0.5 drawn twice → 0.75); at opacity 1.0 it was wasted
// over-draw. The VTR vector path reads the selector ox ONCE
// (tile-selection-cache `worldOffDeg`) and draws each tile once — ADR-0006,
// one copy-set per pipeline.
//
// Fix: the SELECTOR is the single fan-out for the flat-Mercator path. The
// renderer no longer re-fans-out via getVisibleWorldCopies — RASTER_WORLD_COPIES
// is [0]. The globe / ECEF path (projType ≥ 0.5) already collapsed to [0] and
// is unaffected.
//
// ── Oracle ───────────────────────────────────────────────────────────────
// We drive the REAL RasterRenderer.render() against the WebGPU stub (no GPU).
// The renderer writes each draw's bounds into a pooled 48-byte tile uniform
// buffer via `device.queue.writeBuffer`; tf[0] is the tile's west longitude
// in its target world copy (`west + wo*360`) — i.e. the WORLD POSITION the
// draw paints. We intercept those writes and collect one world position per
// `pass.draw()`. The tile cache is pre-seeded for every selected tile so the
// draw loop reaches `pass.draw` without any network fetch.
//
// Assertions:
//   • NO two draws target the same world position (no (ox,wo) collision).
//   • The SET of drawn world positions is UNCHANGED by the fix — only
//     duplicates are removed, coverage is preserved (every visible world tile
//     is still drawn exactly once).
//
// Pre-fix this fails: the cartesian product ox×wo collides, e.g. tile copy
// ox=0 at wo=-1 (west=-540) and tile copy ox=-1 at wo=0 (west=-540) both draw
// at the same world position, and the draw count (36) exceeds the distinct
// world-position count (12).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer } from '@xgis/map'
import { Camera } from '@xgis/engine'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/engine'

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
  const canvas = { width: 2000, height: 800 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// Flat-Mercator low-zoom scenario where BOTH enumerations are multi-copy.
// Verified with the live selector + camera (see commit body): at z=1 on a
// 2000×800 canvas the selector emits ox copies [-1,0,1] and
// getVisibleWorldCopies returns wo=[-1,0,1] — so the buggy ox×wo product has
// genuine collisions, while the correct answer draws each ox-tile once.
const ZOOM = 1
const W = 2000
const H = 800
const DPR = 1
const PROJ_TYPE = 0 // flat Mercator

// A draw's world position is its full ground footprint — west longitude
// (which carries the world-copy offset via `ox`) AND south latitude (which
// distinguishes tiles that share a copy but sit in different latitude bands).
// Keying on west ALONE would conflate `(ox0, y0)` and `(ox0, y1)`.
// 3 decimals absorbs the f32-vs-f64 rounding gap between the renderer's
// Float32Array tile uniform (tf[1] south) and the f64 oracle recompute
// (~3e-6° at the pole), while staying far finer than the smallest gap
// between genuinely distinct world tiles in this scenario.
function posKey(west: number, south: number): string {
  return `${west.toFixed(3)}|${south.toFixed(3)}`
}

/** Reconstruct the world-position SET the selector alone defines (each
 *  ox-tile's (west, south) ground footprint). This is the deduped, correct
 *  draw set — what the renderer should produce after the fix. */
function selectorWorldPositions(camera: Camera): string[] {
  const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
  const tiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)
  const set = new Set<string>()
  for (const t of tiles) {
    const rn = Math.pow(2, t.z)
    const ox = t.ox ?? t.x
    const west = (ox / rn) * 360 - 180
    const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / rn))) * 180) / Math.PI
    set.add(posKey(west, south))
  }
  return [...set].sort()
}

/** Drive render() once and return the per-draw world position
 *  (`posKey(tf[0]=west, tf[1]=south)`) captured from each pooled tile-uniform
 *  writeBuffer. */
function capturedDrawWorldPositions(ctx: GPUContext): string[] {
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')

  const camera = new Camera(0, 0, ZOOM)
  camera.projType = PROJ_TYPE

  // Pre-seed the tile cache for EVERY tile the selector will emit so the draw
  // loop reaches pass.draw without a network fetch. Use the SAME selector
  // call the renderer makes internally.
  const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
  const tiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)
  const cache = (
    renderer as unknown as {
      tileCache: Map<
        string,
        { texture: unknown; lastUsedFrame: number; firstShownFrame: number; globalBG?: unknown }
      >
    }
  ).tileCache
  const fakeTexture = { createView: () => ({}), destroy: () => undefined }
  for (const t of tiles) {
    const key = `${t.z}/${t.x}/${t.y}`
    cache.set(key, { texture: fakeTexture, lastUsedFrame: 0, firstShownFrame: 0 })
  }

  // Identify the per-draw pooled tile-uniform buffers (size 48) vs the global
  // uniform buffer (size 128). Capture tf[0] from every 48-byte write that
  // immediately precedes a draw.
  const drawPositions: string[] = []
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    const size = (buf as { size?: number })?.size
    if (size !== 48) return // skip the 128-byte global uniform write
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            12,
          )
    // tf[0] = west, tf[1] = south — the draw's world-copy ground footprint.
    drawPositions.push(posKey(f32[0], f32[1]))
  }

  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()

  renderer.render(pass, camera, PROJ_TYPE, 0, 0, W, H, DPR)

  return drawPositions
}

describe('raster flat-Mercator world-copy single-source fan-out', () => {
  it('the scenario genuinely exercises double-enumeration (multi ox AND multi wo)', () => {
    // Guard the oracle: if the camera/selector ever stops producing a
    // multi-copy view here, the no-duplicate assertion below would pass
    // trivially. Pin that both enumerations are multi-copy.
    const camera = new Camera(0, 0, ZOOM)
    camera.projType = PROJ_TYPE
    const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
    const tiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)
    const oxCopies = new Set(tiles.map((t) => Math.floor((t.ox ?? t.x) / Math.pow(2, t.z))))
    const wo = camera.getVisibleWorldCopies(W, H, DPR)
    expect(oxCopies.size, 'selector must emit >1 world copy (baked into ox)').toBeGreaterThan(1)
    expect(wo.length, 'getVisibleWorldCopies must return >1 wo').toBeGreaterThan(1)
  })

  it('draws each visible world tile EXACTLY once (no (ox,wo) collision)', async () => {
    const ctx = await makeCtx()
    const positions = capturedDrawWorldPositions(ctx)

    expect(positions.length, 'render() should issue at least one draw').toBeGreaterThan(0)

    // No two draws may target the same world position. Pre-fix the ox×wo
    // product produces duplicates (e.g. west=-540 from ox=0/wo=-1 AND
    // ox=-1/wo=0 at the same latitude band).
    const seen = new Map<string, number>()
    for (const p of positions) seen.set(p, (seen.get(p) ?? 0) + 1)
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1)
    expect(duplicates, `duplicate world positions drawn: ${JSON.stringify(duplicates)}`).toEqual([])

    // Draw count equals distinct-position count — one draw per world tile.
    expect(positions.length).toBe(seen.size)
  })

  it('coverage is unchanged: drawn world-position SET equals the selector set', async () => {
    const ctx = await makeCtx()
    const positions = capturedDrawWorldPositions(ctx)
    const drawnSet = [...new Set(positions)].sort()

    const camera = new Camera(0, 0, ZOOM)
    camera.projType = PROJ_TYPE
    const expected = selectorWorldPositions(camera)

    // The fix removes DUPLICATES only — every world position the selector
    // covers is still drawn exactly once, none is dropped, none is added.
    expect(drawnSet).toEqual(expected)
  })
})

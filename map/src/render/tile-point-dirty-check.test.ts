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
import { WebGpuDevice, wrapWebGpuPass, unwrapWebGpuBuffer } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'
import { lonLatToECEF } from '@xgis/shared'
import { buildTilePointPackKey, hashStableKeys } from './tile-point-pack-key'
import type { TilePointCache } from './tile-point-cache'
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

/** Like `countTilePointBufferCreates`, but also counts the `destroy()` calls the
 *  RHI makes on those buffers — the eviction leg's only observable (#1632). */
function countTilePointBuffers(device: GPUDevice): { created(): number; destroyed(): number } {
  let created = 0
  let destroyed = 0
  const real = device.createBuffer.bind(device)
  ;(device as { createBuffer: typeof device.createBuffer }).createBuffer = (
    desc: GPUBufferDescriptor,
  ) => {
    const buf = real(desc)
    if (typeof desc.label === 'string' && desc.label.startsWith('tile-point-')) {
      created++
      const realDestroy = buf.destroy.bind(buf)
      ;(buf as { destroy: () => void }).destroy = () => {
        destroyed++
        realDestroy()
      }
    }
    return buf
  }
  return { created: () => created, destroyed: () => destroyed }
}

/** Like `countTilePointBufferCreates`, but keeps the created buffer OBJECTS
 *  (labelled) instead of just their count — lets a test recover the exact
 *  vertex/index/feat trio a given flush produced, to check per-show IDENTITY
 *  rather than a shared aggregate number (#1632). */
function captureTilePointBuffers(device: GPUDevice): {
  made(): { label: string; buf: GPUBuffer }[]
} {
  const made: { label: string; buf: GPUBuffer }[] = []
  const real = device.createBuffer.bind(device)
  ;(device as { createBuffer: typeof device.createBuffer }).createBuffer = (
    desc: GPUBufferDescriptor,
  ) => {
    const buf = real(desc)
    if (typeof desc.label === 'string' && desc.label.startsWith('tile-point-'))
      made.push({ label: desc.label, buf })
    return buf
  }
  return { made: () => made }
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
    const ID = '1:layer' // the VTR's `${instancePrefix}${sliceLayer}` show id (#1632)
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
    expect(renderer.canSkipTilePointRepack(ID, key)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, key, ID)
    expect(creates.count()).toBe(3)

    // Frames 2..21 — static camera, unchanged style: the VTR call site skips
    // accumulation entirely and redraws from the cached buffers.
    for (let i = 0; i < 20; i++) {
      expect(renderer.canSkipTilePointRepack(ID, key)).toBe(true)
      renderer.redrawTilePointsCached(ID, args)
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
    expect(renderer.canSkipTilePointRepack(ID, key2)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, changedShow, 1, key2, ID)
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
    const ID = '1:layer'
    const atOrigin = keyFor(view(100, 200, 4, 4), show)
    expect(renderer.canSkipTilePointRepack(ID, atOrigin)).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, atOrigin, ID)
    expect(creates.count()).toBe(3)

    // Frame 2 — same zoom, same pitch, same style: ONLY the tile set moved, by a
    // single tile east. Four of the sixteen tiles are new.
    const panned = keyFor(view(101, 200, 4, 4), show)
    expect(
      renderer.canSkipTilePointRepack(ID, panned),
      'a pan brought new tiles into view — reusing the pack means their points never draw',
    ).toBe(false)
    addPoint(renderer, 10, 30)
    renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, panned, ID)
    expect(creates.count(), 'the pan must have rebuilt the three tile-point buffers').toBe(6)

    // CONTROL — holding still after the pan must still reuse, or this gate would
    // pass by breaking the memo outright rather than by fixing its key.
    expect(renderer.canSkipTilePointRepack(ID, keyFor(view(101, 200, 4, 4), show))).toBe(true)
    expect(creates.count(), 'no rebuild while the view is unchanged').toBe(6)
  })
})

// ═══ TWO point shows must each hold their OWN pack (#1632) ═══
//
// `scene-renderers.ts` builds ONE PointRenderer per map, but
// `VectorTileRenderer.emitTilePointsRhi` runs once per point SHOW per frame.
// The #1581 leg-B memo kept a SINGLE `_lastTilePointPackKey` plus one buffer
// trio, so with two point shows each flush overwrote the key the other had just
// stamped: `canSkipTilePointRepack` missed EVERY frame, forever, and three GPU
// buffers were recreated per show per frame at a dead-still camera. A halo layer
// plus a pin layer is the shape of essentially every shipped point demo, so the
// #1581 optimization was off in exactly the scenes it was written for.
//
// NON-VACUITY, by cutting the mechanism rather than the premise (2026-07-28
// ledger entry): make `TilePointCache` ignore its `showId` argument — one shared
// slot, i.e. the pre-#1632 behaviour behind the post-#1632 signature — and frame
// 2's first assertion goes red naming show A (its key no longer matches the one
// show B stamped at the end of frame 1), with the create count climbing by 6 per
// frame instead of holding at 6. The keys of the two shows differ (sliceLayer,
// fill AND size), which is what makes the single slot thrash; two shows with an
// identical key would hit even on the broken code and prove nothing.
describe('per-show tile-point pack slots (#1632)', () => {
  type TilePointShowLike = Parameters<typeof buildTilePointPackKey>[2]
  const SHOW_A: TilePointShowLike = { fill: '#ff8800', stroke: null, size: 6, opacity: 1 }
  const SHOW_B: TilePointShowLike = { fill: '#0088ff', stroke: null, size: 3, opacity: 1 }
  // `${VectorTileRenderer instance prefix}${sliceLayer}`, as emitTilePointsRhi mints it.
  const ID_A = '1:halo'
  const ID_B = '1:pins'
  const keyFor = (
    slice: string,
    show: TilePointShowLike,
  ): ReturnType<typeof buildTilePointPackKey> =>
    buildTilePointPackKey(hashStableKeys([1, 2, 3]), slice, show, 4, 0, 0, 0b00100)

  it('two shows at a static camera both stop rebuilding after frame 1', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    const camera = new Camera(0, 0, 4)
    camera.projType = 0
    const creates = countTilePointBufferCreates(ctx.device as unknown as GPUDevice)
    const madeBuffers = captureTilePointBuffers(ctx.device as unknown as GPUDevice)
    const encoder = (
      ctx.device as unknown as {
        createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
      }
    ).createCommandEncoder()
    const pass = wrapWebGpuPass(encoder.beginRenderPass())
    const argsFor = (show: TilePointShowLike) => ({
      pass,
      camera,
      projType: 0,
      projCenterLon: 0,
      projCenterLat: 0,
      canvasWidth: 1024,
      canvasHeight: 768,
      show,
      dpr: 1,
    })
    const flush = (
      id: string,
      show: TilePointShowLike,
      key: ReturnType<typeof buildTilePointPackKey>,
    ): void => {
      addPoint(renderer, 10, 30)
      renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, key, id)
    }

    const keyA = keyFor('halo', SHOW_A)
    const keyB = keyFor('pins', SHOW_B)

    // Frame 1 — neither show is cached: both accumulate, repack and build.
    renderer.beginFrame()
    expect(renderer.canSkipTilePointRepack(ID_A, keyA)).toBe(false)
    flush(ID_A, SHOW_A, keyA)
    expect(renderer.canSkipTilePointRepack(ID_B, keyB)).toBe(false)
    flush(ID_B, SHOW_B, keyB)
    expect(creates.count(), 'frame 1 builds three buffers per show').toBe(6)

    // IDENTITY — each show's flush must have built its OWN buffer trio, not one
    // shared with (or aliased to) the other show's. This is the object-identity
    // half of #1632: the create COUNT above is satisfied even if both flushes
    // happened to hand back the same six buffers in some broken pooling scheme,
    // so distinctness has to be asserted directly.
    const made = madeBuffers.made()
    expect(made).toHaveLength(6)
    const trioA = made.slice(0, 3)
    const trioB = made.slice(3, 6)
    for (const a of trioA)
      for (const b of trioB)
        expect(a.buf, `show A's ${a.label} must not be show B's ${b.label}`).not.toBe(b.buf)

    const cache = (renderer as unknown as { _tilePointCache: TilePointCache })._tilePointCache
    const bufOf = (trio: typeof trioA, label: string): GPUBuffer =>
      trio.find((b) => b.label === label)!.buf

    // Frames 2..11 — dead-still camera, unchanged tile set, unchanged styles.
    // BOTH shows must skip, every frame; the pre-#1632 single slot missed both.
    for (let frame = 2; frame <= 11; frame++) {
      renderer.beginFrame()
      expect(
        renderer.canSkipTilePointRepack(ID_A, keyA),
        `show A repacked on frame ${frame} — its slot was clobbered by the other show`,
      ).toBe(true)
      renderer.redrawTilePointsCached(ID_A, argsFor(SHOW_A))
      // IDENTITY — the cached redraw path resolves its GPU buffers from
      // `_tilePointCache.get(showId)` (mirrors `_tilePointDrawDeps`, which builds
      // the real draw's deps the same way). A slot mixup would draw show A with
      // show B's feature/shape data — invisible to a create-count or a boolean
      // canSkipTilePointRepack, since neither one is sensitive to WHICH trio is
      // bound, only whether a repack happened. Slots hold RhiBuffer wrappers
      // (a fresh `{native}` box per read), so identity is checked on the
      // unwrapped native GPUBuffer, not the wrapper.
      const slotA = cache.get(ID_A)!
      expect(
        unwrapWebGpuBuffer(slotA.buffer),
        `show A bound the wrong vertex buffer on frame ${frame}`,
      ).toBe(bufOf(trioA, 'tile-point-vertices'))
      expect(
        unwrapWebGpuBuffer(slotA.indexBuffer),
        `show A bound the wrong index buffer on frame ${frame}`,
      ).toBe(bufOf(trioA, 'tile-point-indices'))
      expect(
        unwrapWebGpuBuffer(slotA.featBuffer),
        `show A bound the wrong feature buffer on frame ${frame}`,
      ).toBe(bufOf(trioA, 'tile-point-features'))
      expect(
        renderer.canSkipTilePointRepack(ID_B, keyB),
        `show B repacked on frame ${frame} — its slot was clobbered by the other show`,
      ).toBe(true)
      renderer.redrawTilePointsCached(ID_B, argsFor(SHOW_B))
      const slotB = cache.get(ID_B)!
      expect(
        unwrapWebGpuBuffer(slotB.buffer),
        `show B bound the wrong vertex buffer on frame ${frame}`,
      ).toBe(bufOf(trioB, 'tile-point-vertices'))
      expect(
        unwrapWebGpuBuffer(slotB.indexBuffer),
        `show B bound the wrong index buffer on frame ${frame}`,
      ).toBe(bufOf(trioB, 'tile-point-indices'))
      expect(
        unwrapWebGpuBuffer(slotB.featBuffer),
        `show B bound the wrong feature buffer on frame ${frame}`,
      ).toBe(bufOf(trioB, 'tile-point-features'))
    }
    expect(creates.count(), 'ten static frames must build nothing').toBe(6)

    // CONTROL — restyling ONE show rebuilds ONLY that show. A cache that never
    // invalidates, or one that invalidates every slot at once, both fail here.
    const restyledA: TilePointShowLike = { ...SHOW_A, fill: '#00ff00' }
    const keyA2 = keyFor('halo', restyledA)
    renderer.beginFrame()
    expect(renderer.canSkipTilePointRepack(ID_A, keyA2)).toBe(false)
    flush(ID_A, restyledA, keyA2)
    expect(creates.count(), 'only show A rebuilds').toBe(9)
    expect(
      renderer.canSkipTilePointRepack(ID_B, keyB),
      'show B was untouched by show A restyling — it must still reuse its pack',
    ).toBe(true)
    expect(creates.count()).toBe(9)
  })

  // The eviction leg. Slots are keyed by a VectorTileRenderer-minted id, so when
  // that renderer is destroyed (setSourceData swap, style edit, teardown) nothing
  // will ever redraw its slots — and GPU bytes exert no JS GC pressure, so
  // without an explicit evict each dropped point show leaks three buffers for the
  // page's lifetime. Fail-before: with `evictTilePointSlots` a no-op, `destroyed`
  // stays 0 and show A's slot keeps answering "skip".
  it('destroying a VectorTileRenderer frees its slots and only its slots', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    const camera = new Camera(0, 0, 4)
    camera.projType = 0
    const bufs = countTilePointBuffers(ctx.device as unknown as GPUDevice)
    const encoder = (
      ctx.device as unknown as {
        createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
      }
    ).createCommandEncoder()
    const pass = wrapWebGpuPass(encoder.beginRenderPass())

    // Two shows from renderer #1, one from renderer #2 — the prefix is the only
    // thing separating them, and `1:` must not evict `10:`'s look-alike slot.
    const keyA = keyFor('halo', SHOW_A)
    const keyB = keyFor('pins', SHOW_B)
    const keyOther = keyFor('halo', SHOW_A)
    const flush = (
      id: string,
      show: TilePointShowLike,
      key: ReturnType<typeof buildTilePointPackKey>,
    ): void => {
      addPoint(renderer, 10, 30)
      renderer.flushTilePointsRhi(pass, camera, 0, 0, 0, 1024, 768, show, 1, key, id)
    }
    flush(ID_A, SHOW_A, keyA)
    flush(ID_B, SHOW_B, keyB)
    flush('10:halo', SHOW_A, keyOther)
    expect(bufs.created()).toBe(9)
    expect(bufs.destroyed(), 'nothing retired yet — every slot is fresh').toBe(0)

    // VectorTileRenderer #1 is destroyed: both of ITS slots go, the other stays.
    renderer.evictTilePointSlots('1:')
    expect(
      bufs.destroyed(),
      'evicted buffers are retired, not destroyed inline — a submit may still bind them',
    ).toBe(0)
    renderer.beginFrame()
    expect(bufs.destroyed(), 'six buffers freed at the start of the next frame').toBe(6)
    expect(renderer.canSkipTilePointRepack(ID_A, keyA)).toBe(false)
    expect(renderer.canSkipTilePointRepack(ID_B, keyB)).toBe(false)
    expect(
      renderer.canSkipTilePointRepack('10:halo', keyOther),
      "the prefix is a renderer namespace, not a substring — '1:' must not reach '10:'",
    ).toBe(true)
    expect(bufs.created(), 'eviction builds nothing').toBe(9)
  })
})

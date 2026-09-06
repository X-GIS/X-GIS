// ═══ Globe vector drape — per-slice pool-uniform aliasing on WebGPU (#1142) ═══
//
// THE BUG (WebGPU-only, OFM/multi-slice-only): all vector shows of ONE source
// share ONE VectorTileRenderer → ONE VectorDrapeRenderer → ONE RasterDraper
// `Material`. On the globe sphere route each drape-eligible slice (landcover /
// landuse / water / …) issues its OWN `draper.draw()` → `executeItems()` call,
// and they all encode into the SINGLE per-frame command submit. `executeItems`
// resets its pool cursor to 0 on every call and `Material.poolSlot(i)` REUSES
// `poolBufs[i]`, so slice B's tile i overwrites the buffer slice A's tile i was
// bound to. Because `rhi.writeBuffer` on WebGPU is `queue.writeBuffer` — DEFERRED
// to the submit boundary (last-writer-wins) — every encoded draw reads the FINAL
// buffer contents at submit: slice A's tile i is drawn at slice B's tile i bounds.
// A tile renders at ANOTHER tile's location ("다른 타일에 그린걸 잘못 가져와서
// 렌더"). On WebGL2 `writeBuffer` is immediate (bufferSubData) so the write-then-
// draw interleaving is safe → the bug is WebGPU-exclusive, matching the report.
// `minimal` (a single constant-fill slice) issues ONE draw() → no reuse → the
// prior `minimal` repro could never trigger it; switched-vs-direct parity is blind
// (both globe renders alias identically → diff 0).
//
// THE FIX: VectorDrapeRenderer threads a FRAME-MONOTONIC pool base into the shared
// RasterDraper.draw → executeItems, reset once per frame in beginFrame(), so each
// per-slice draw() gets its OWN pool slots and no in-flight buffer is overwritten
// before the single submit reads it.
//
// This test models WebGPU's deferred-writeBuffer semantics with a mock RHI: a
// pool buffer's bytes are last-writer-wins, and each draw's per-tile uniform is
// read at SUBMIT (not at encode). FAIL-BEFORE: slice A's draw reads slice B's
// bounds. GPU-free; rides the `test (map)` CI leg.

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { VectorDrapeRenderer, type DrapeBakeProvider } from './vector-drape-renderer'
import { rasterU, rasterTileU } from '../shaders/dsl/raster'
import type { GPUTile } from './vector-tile-renderer-types'

// ── A mock RhiTexture the bake provider hands back (no `.createView` → the draper
// resolves it via `rhi.createView`, avoiding the WebGPU view-wrap path). ──
interface MockBuf {
  __id: number
  __bytes: Uint8Array | null
}

/** Records createBuffer/writeBuffer + hands out mock pipelines/bind groups. A
 *  written buffer keeps ONLY its latest bytes (models `queue.writeBuffer`
 *  last-writer-wins before the frame submit). */
function makeMockRhi() {
  let id = 0
  const rhi = {
    backend: 'webgpu' as const,
    // #1678 — the raster draper now asks the language CAPABILITY (`readsWgsl`) instead
    // of emitting both languages unconditionally, so a device double must carry it.
    caps: { shaderLanguage: 'wgsl' },
    createBindGroupLayout: () => ({ __layout: true }),
    createPipeline: () => ({ __pipe: true }),
    createSampler: () => ({ __sampler: true }),
    createBuffer: (_d: { size: number; usage: string }): MockBuf => ({ __id: ++id, __bytes: null }),
    createTexture: (d: { label?: string }) => ({ __tex: true, label: d.label ?? '' }),
    createView: () => ({ __view: true }),
    // #2539 — RasterDraper initialises a 1x1 DEM stub on its first draw (the
    // group-0 binding the shared `vs_tile` reads elevation from must be filled
    // even with no terrain). A double that omits this is not a passing test, it
    // is `TypeError: this.rhi.writeTexture is not a function` inside draw — the
    // hazard is that the cast to RhiDevice hides it from tsc entirely, so the
    // whole suite compiles green and dies at run time (CLAUDE.md §12).
    writeTexture: () => {},
    // resource: { buffer } for pool + global; { view }/sampler for texture — we
    // only need the buffer back so the pass can read the bound pool slot.
    createBindGroup: (_layout: unknown, entries: { resource?: { buffer?: MockBuf } }[]) => ({
      __bg: true,
      buffer: entries[0]?.resource?.buffer ?? null,
    }),
    writeBuffer: (buf: MockBuf, _off: number, data: BufferSource) => {
      const src =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength,
            )
      buf.__bytes = src.slice() // COPY — later writes to this buffer overwrite it
    },
    destroyTexture: () => {},
  }
  return rhi
}

interface DrawSnap {
  poolBuf: MockBuf | null
  intended: Uint8Array | null // pool bytes at ENCODE time (what this draw meant to read)
  globalBuf: MockBuf | null // group-0 (shared global) buffer this draw bound
}

/** Mock pass. Group 1 (RasterDraper's pool group) carries the per-tile uniform;
 *  each draw snapshots the currently-bound pool buffer + its bytes at encode, and
 *  the group-0 buffer holding the shared global uniform. */
function makeMockPass(poolGroup: number) {
  const draws: DrawSnap[] = []
  let curPool: MockBuf | null = null
  let curGlobal: MockBuf | null = null
  const snap = (): DrawSnap => ({
    poolBuf: curPool,
    intended: curPool?.__bytes ? curPool.__bytes.slice() : null,
    globalBuf: curGlobal,
  })
  const pass = {
    setPipeline: () => {},
    setBindGroup: (group: number, bg: { buffer?: MockBuf } | null) => {
      if (group === poolGroup) curPool = bg?.buffer ?? null
      if (group === 0) curGlobal = bg?.buffer ?? null
    },
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    draw: () => {
      draws.push(snap())
    },
    drawIndexed: () => {
      draws.push(snap())
    },
  }
  return { pass, draws }
}

function tile(uploadEpoch: number, west: number, south: number): GPUTile {
  // Only the fields renderGlobeFills reads. Distinct west/south ⇒ distinct
  // per-tile drape bounds ⇒ distinct pool bytes.
  return {
    extruded: false,
    uploadEpoch,
    tileWest: west,
    tileSouth: south,
    tileWidth: 90,
    tileHeight: 90,
    tileZoom: 2,
  } as unknown as GPUTile
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('globe vector drape — per-slice pool aliasing (#1142)', () => {
  it('two slices in one frame each draw with their OWN per-tile bounds at submit', () => {
    const rhi = makeMockRhi()
    // RasterDraper pool lives at group 1 (raster-material.ts). The per-tile
    // uniform the drape writes there is what must not alias across slice draws.
    const POOL_GROUP = 1
    const drape = new VectorDrapeRenderer(
      rhi as unknown as ConstructorParameters<typeof VectorDrapeRenderer>[0],
      'rgba8unorm',
      1,
    )
    const { pass, draws } = makeMockPass(POOL_GROUP)

    // Two slices over ONE source → the SAME drape. Each has ONE visible tile, at
    // DIFFERENT bounds (the real repro: per-slice neededKeys diverge).
    const layerA = new Map<number, GPUTile>([[100, tile(1, -180, 0)]])
    const layerB = new Map<number, GPUTile>([[200, tile(1, 0, -85.051129)]])

    // Provider returns a distinct mock texture per (sliceLayer, key).
    const provider: DrapeBakeProvider = {
      bakeTileToTexture: (sliceLayer, key) =>
        ({ __rhiBake: true, label: `vtr-bake-${sliceLayer}-${key}` }) as never,
    }

    const frame = { matrix: new Float32Array(16), logDepthFc: 1 }
    const fill: [number, number, number, number] = [0.5, 0.5, 0.5, 1]

    // Frame boundary — resets the frame-monotonic pool base.
    drape.beginFrame()
    // Slice A draw, then slice B draw — both encode into the SAME `pass` (one
    // per-frame submit), reusing the shared RasterDraper.material pool.
    drape.renderGlobeFills(
      pass as never,
      frame,
      1,
      0,
      0,
      { centerX: 0, centerY: 0 },
      1,
      fill,
      0,
      1, // camZoom (#1222) — bake-native for tile z1
      'sliceA',
      [100],
      undefined,
      layerA,
      provider,
    )
    drape.renderGlobeFills(
      pass as never,
      frame,
      1,
      0,
      0,
      { centerX: 0, centerY: 0 },
      1,
      fill,
      0,
      1, // camZoom (#1222) — bake-native for tile z1
      'sliceB',
      [200],
      undefined,
      layerB,
      provider,
    )

    // SUBMIT: every encoded draw now reads the FINAL contents of its bound pool
    // buffer (deferred writeBuffer). Each draw must still see the bytes it encoded.
    expect(draws.length, 'both slice draws should have issued exactly one tile draw').toBe(2)
    for (let d = 0; d < draws.length; d++) {
      const snap = draws[d]!
      const finalBytes = snap.poolBuf?.__bytes ?? null
      expect(
        bytesEqual(finalBytes, snap.intended),
        `drape draw #${d}: its per-tile pool buffer was OVERWRITTEN by a later slice's ` +
          `draw before the single frame submit — this tile renders at another tile's bounds ` +
          `(WebGPU deferred writeBuffer aliasing, #1142).`,
      ).toBe(true)
    }

    // Strong form: the two draws must bind DIFFERENT pool buffers (else slot reuse
    // guarantees the overwrite above).
    expect(
      draws[0]!.poolBuf !== draws[1]!.poolBuf,
      'the two per-slice drape draws must not share a pool buffer within one frame submit.',
    ).toBe(true)
  })
})

// ═══ Globe vector drape — per-slice GLOBAL uniform (fill-opacity) aliasing ═══
//
// hunt 2026-09-02: #2291 — #1142 gave each slice-layer its own POOL slots but the
// per-show fill-opacity still travelled in the ONE shared global uniform, which
// `RasterDraper.draw` rewrites per call; with WebGPU's deferred writeBuffer every
// draped slice ended up sampling the LAST slice's opacity at submit.
//
// The assertion is on the quantity the shader actually multiplies into alpha —
// `raster_params.x * tile_ecef_center.w` (shaders/dsl/raster.ts fs_tile) — read at
// SUBMIT, so it pins the observable per-slice opacity rather than which lane
// carries it.
describe('globe vector drape — per-slice fill-opacity (#2291)', () => {
  it('two slices in one frame each drape with their OWN fill-opacity at submit', () => {
    const rhi = makeMockRhi()
    const POOL_GROUP = 1
    const drape = new VectorDrapeRenderer(
      rhi as unknown as ConstructorParameters<typeof VectorDrapeRenderer>[0],
      'rgba8unorm',
      1,
    )
    const { pass, draws } = makeMockPass(POOL_GROUP)

    const globalOpacityOff = uniformBlock(rasterU).fieldOffset('raster_params') // .x
    const tileVisOff = uniformBlock(rasterTileU).fieldOffset('tile_ecef_center') + 12 // .w
    const f32At = (b: MockBuf | null, off: number): number =>
      b?.__bytes ? new DataView(b.__bytes.buffer, b.__bytes.byteOffset).getFloat32(off, true) : NaN

    // Two shows over ONE source → the SAME drape, SAME tile bounds: the only
    // difference is the per-show fill-opacity.
    const layerA = new Map<number, GPUTile>([[100, tile(1, -180, 0)]])
    const layerB = new Map<number, GPUTile>([[100, tile(1, -180, 0)]])
    const provider: DrapeBakeProvider = {
      bakeTileToTexture: (sliceLayer, key) =>
        ({ __rhiBake: true, label: `vtr-bake-${sliceLayer}-${key}` }) as never,
    }
    const frame = { matrix: new Float32Array(16), logDepthFc: 1 }
    const fill: [number, number, number, number] = [0.5, 0.5, 0.5, 1]
    const opacities = [0.3, 0.85] // neither is 1 — a fix that DROPS opacity also fails

    drape.beginFrame()
    for (const [i, o] of opacities.entries()) {
      drape.renderGlobeFills(
        pass as never,
        frame,
        1,
        0,
        0,
        { centerX: 0, centerY: 0 },
        o,
        fill,
        0,
        1, // camZoom (#1222) — bake-native for tile z1
        i === 0 ? 'landuse' : 'water',
        [100],
        undefined,
        i === 0 ? layerA : layerB,
        provider,
      )
    }

    expect(draws.length, 'both slice draws should have issued exactly one tile draw').toBe(2)
    // SUBMIT: every encoded draw reads the FINAL bytes of the buffers it bound.
    for (const [d, want] of opacities.entries()) {
      const snap = draws[d]!
      const got = f32At(snap.globalBuf, globalOpacityOff) * f32At(snap.poolBuf, tileVisOff)
      expect(
        got,
        `drape draw #${d} (fill-opacity ${want}): at submit its alpha factor is ${got} — the ` +
          `per-show opacity is carried in a buffer a LATER slice overwrote before the single ` +
          `frame submit, so every draped layer renders with the last slice's opacity (#2291).`,
      ).toBeCloseTo(want, 5)
    }
  })
})

// ═══ #2249 — `fill-translate` reaches the globe DRAPE path ═══
//
// The DIRECT fill draw applies fill-translate in the polygon VS
// (shaders/dsl/polygon.ts: `clip.x += fillTx·clip.w`, `clip.y -= fillTy·clip.w`).
// The drape's sphere draw has no such site: it draws BAKED tile textures with a
// plain camera MVP, and the bake deliberately packs the offset as 0 (its ortho
// has clip.w === 1 over a single tile, so a canvas-pixel NDC offset is
// dimensionally wrong there and would seam between tiles — that literal 0 is
// ratcheted in fill-translate-ndc.test.ts and is NOT the defect).
//
// So an authored `fill-translate` moved the fill on the flat map and was
// silently dropped on the globe. The fix folds it into the MVP one stage
// earlier: clip = M·v, so shifting clip.xy by t·clip.w is exactly adding
// t·(row 3) into rows 0/1 of M. No shader edit, no re-bake.
//
// This test reads the GLOBAL uniform the drape writes (mvp is its first field,
// raster-renderer.ts writeRasterFrameUniform) and checks the 16 floats.
//
// FAIL-BEFORE: drop the `fillTranslateNdc` argument at the renderGlobeFills call
// in vector-tile-renderer.ts (or the row-op in vector-drape-renderer.ts) and the
// first case reds — the written mvp is then the untranslated camera matrix.

import { describe, it, expect } from 'vitest'
import { VectorDrapeRenderer, type DrapeBakeProvider } from './vector-drape-renderer'
import type { GPUTile } from './vector-tile-renderer-types'
import { renderPathSource } from './render-path-source'

interface MockBuf {
  __id: number
  __bytes: Uint8Array | null
}

/** Mock RHI that keeps every buffer's latest bytes. The GLOBAL uniform block is
 *  the biggest non-pool buffer the drape writes; we find it by size. */
function makeMockRhi(): {
  rhi: unknown
  writes: { buf: MockBuf; bytes: Uint8Array }[]
  demStubWrites: number[]
} {
  let id = 0
  const writes: { buf: MockBuf; bytes: Uint8Array }[] = []
  const demStubWrites: number[] = []
  const rhi = {
    backend: 'webgpu' as const,
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
    writeTexture: (_t: unknown, data: BufferSource, ..._r: number[]) => {
      demStubWrites.push((data as ArrayBufferView).byteLength)
    },
    createBindGroup: () => ({ __bg: true }),
    // `data` is a BufferSource: the drape passes an ArrayBuffer on some paths
    // and a typed-array view on others. Handling only the view shape reads the
    // whole test as a null-deref rather than as a failing assertion.
    writeBuffer: (buf: MockBuf, _off: number, data: BufferSource) => {
      const src =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength,
            )
      const bytes = new Uint8Array(src) // copy — the caller may reuse its scratch
      buf.__bytes = bytes
      writes.push({ buf, bytes })
    },
    destroyBuffer: () => {},
    destroyTexture: () => {},
  }
  return { rhi, writes, demStubWrites }
}

const noopPass = {
  setPipeline: () => {},
  setBindGroup: () => {},
  setVertexBuffer: () => {},
  setIndexBuffer: () => {},
  draw: () => {},
  drawIndexed: () => {},
}

function tile(): GPUTile {
  return {
    extruded: false,
    uploadEpoch: 1,
    tileWest: -180,
    tileSouth: 0,
    tileWidth: 90,
    tileHeight: 90,
    tileZoom: 2,
  } as unknown as GPUTile
}

const provider: DrapeBakeProvider = {
  bakeTileToTexture: (sliceLayer, key) =>
    ({ __rhiBake: true, label: `b-${sliceLayer}-${key}` }) as never,
}

/** A deliberately NON-trivial projective matrix: a real MVP has a non-constant
 *  w row, which is the whole point — a translate folded as `m[12] += tx` would
 *  be correct only when w is identically 1. Column-major, element (row r,
 *  col c) = m[c*4+r]. */
const MVP = new Float32Array([
  2.0, 0.1, 0.0, 0.3, 0.2, 1.7, 0.0, -0.4, 0.0, 0.0, -1.0, 0.9, 5.0, -3.0, 2.5, 1.6,
])

/** Run one drape frame and return the mvp (first 16 floats) it wrote. */
function mvpWrittenFor(translate: readonly [number, number] | undefined): Float32Array {
  const { rhi, writes, demStubWrites } = makeMockRhi()
  const drape = new VectorDrapeRenderer(
    rhi as unknown as ConstructorParameters<typeof VectorDrapeRenderer>[0],
    'rgba8unorm',
    1,
  )
  const frame = { matrix: MVP, logDepthFc: 1 }
  drape.beginFrame()
  const args = [
    noopPass as never,
    frame,
    1,
    0,
    0,
    { centerX: 0, centerY: 0 },
    1,
    [0.5, 0.5, 0.5, 1] as [number, number, number, number],
    0,
    1,
    'slice',
    [100],
    undefined,
    new Map<number, GPUTile>([[100, tile()]]),
    provider,
    undefined,
  ] as const

  ;(drape.renderGlobeFills as any)(...args, translate)

  // The GLOBAL block is the frame uniform the drape creates in its constructor,
  // so it carries the lowest buffer id of anything written this frame; the
  // per-tile pool slots come from the Material afterwards and are LARGER (336 B
  // vs 176 B), which is why "the biggest buffer" is the wrong selector here.
  let global: { buf: MockBuf; bytes: Uint8Array } | null = null
  for (const w of writes) if (!global || w.buf.__id < global.buf.__id) global = w
  expect(global, 'the drape must have written a global uniform').not.toBeNull()
  // #2539 — the DEM stub is a GATE here, not a hole. A double that merely CARRIES
  // `writeTexture` would let a future change stop initialising the stub and say
  // nothing; asserting the call means the binding the shared `vs_tile` samples is
  // proven filled on the path this test drives. Exactly one 4-byte write: the 1x1
  // texture is created once per draper and reused for every draw.
  expect(demStubWrites, 'the 1x1 DEM stub was initialised once, with its 4 bytes').toEqual([4])
  // Pin the size: RASTER_U is mvp(64) + 8 vec4s(128) = 192 B. If the block grows
  // a field, this reds here rather than silently reading a shifted mvp.
  //
  // 176 -> 192 (#2539): `dem_unpack` was APPENDED for the terrain displacement, so
  // the mvp this function reads is still at offset 0 and the read below is unchanged
  // — but the tripwire is doing exactly its job by making that a thing someone
  // checked rather than assumed. A field inserted BEFORE the mvp would shift it and
  // this assertion is the only thing that would say so.
  expect(global!.bytes.length, 'RASTER_U global block size changed — re-check the mvp offset').toBe(
    192,
  )
  return new Float32Array(global!.bytes.buffer, global!.bytes.byteOffset, 16)
}

describe('#2249 — fill-translate reaches the globe drape', () => {
  it('a non-zero translate shifts rows 0/1 of the MVP by t·(row 3)', () => {
    const TX = 0.125
    const TY = -0.0625 // both exactly representable → the compare is exact, not fuzzy
    const got = mvpWrittenFor([TX, TY])

    const want = new Float32Array(MVP)
    for (let c = 0; c < 4; c++) {
      const w = want[c * 4 + 3]!
      want[c * 4 + 0] = Math.fround(want[c * 4 + 0]! + TX * w)
      // SUB on y — the polygon VS is the authority for what this property means
      // on screen (`clip.y.sub(...)`). A symmetric `+=` would be wrong-way on y
      // and would show up ONLY on the globe.
      want[c * 4 + 1] = Math.fround(want[c * 4 + 1]! - TY * w)
    }

    expect(
      Array.from(got),
      'the drape wrote an untranslated MVP — fill-translate is being dropped on the globe',
    ).toEqual(Array.from(want))

    // Non-vacuity: the two matrices must actually differ, or the assertion above
    // would pass for a no-op fix.
    expect(Array.from(got), 'translate had no effect at all').not.toEqual(Array.from(MVP))
  })

  it('CONTROL — a zero translate leaves the MVP byte-identical', () => {
    // Without this, hiding the offset behind an always-on transform would still
    // satisfy the case above while moving every existing globe scene.
    expect(Array.from(mvpWrittenFor([0, 0]))).toEqual(Array.from(MVP))
  })

  it('CONTROL — an absent translate (every pre-#2249 caller) is byte-identical too', () => {
    expect(Array.from(mvpWrittenFor(undefined))).toEqual(Array.from(MVP))
  })

  it('the y sign is opposite the x sign — the trap the triage plan got wrong', () => {
    // A symmetric `clip.xy += t·w` reads plausible and is wrong: polygon.ts adds
    // on x and SUBTRACTS on y. Pin it so a future "simplification" reds here
    // rather than on a globe-only pixel nobody looks at.
    const T = 0.25
    const x = mvpWrittenFor([T, 0])
    const y = mvpWrittenFor([0, T])
    const w0 = MVP[3]!
    expect(x[0]! - MVP[0]!).toBeCloseTo(T * w0, 6)
    expect(y[1]! - MVP[1]!).toBeCloseTo(-T * w0, 6)
  })
})

// ─── The WIRING half ────────────────────────────────────────────────────────
//
// The four cases above drive `renderGlobeFills` DIRECTLY with an explicit
// translate, so they prove the drape applies a value it is GIVEN — and nothing
// about whether the VectorTileRenderer actually gives it one. Measured: cutting
// the argument at the VTR call site leaves all four GREEN. That is exactly the
// defect #2249 reports (the drape never received the value), so a gate that
// cannot see it would be the "passes either way" shape.
//
// Driving the real VTR here would need a device, a source, a layer cache and a
// camera — the same reason paintless-show-acquires.test.ts and #2240's gate are
// SOURCE gates on this method. So this is a source gate too, and it is scoped:
// it pins that the ONE call site forwards the ONE producer's fields, and an
// allowlist makes a new literal argument fail loudly instead of silently.

const VTR_SRC = renderPathSource()

describe('#2249 — the VTR actually forwards the pair (wiring)', () => {
  it('renderGlobeFills is called with the fillTranslateNdc fields, not a literal', () => {
    const call = VTR_SRC.slice(VTR_SRC.indexOf('this._drape.renderGlobeFills('))
    const args = call.slice(0, call.indexOf('\n      )'))
    expect(
      args.includes('[this.currentFillTranslateNdcX, this.currentFillTranslateNdcY]'),
      'the drape call does not forward the anchor-rotated NDC pair — fill-translate is dropped on the globe ' +
        '(this is the half the behavioural cases above cannot see: they call renderGlobeFills directly)',
    ).toBe(true)
  })

  it('and those fields come from the #2240 single producer, not a second computation', () => {
    // If someone recomputes the pair inline for the drape, the two paths can
    // drift — which is the bug #2240 fixed for the three packers. Pin that the
    // fields are assigned from fillTranslateNdc(...) and nowhere else.
    const assigns = VTR_SRC.match(/this\.currentFillTranslateNdcX\s*=/g) ?? []
    expect(assigns.length, 'currentFillTranslateNdcX is assigned in more than one place').toBe(1)
    const at = VTR_SRC.indexOf('this.currentFillTranslateNdcX =')
    const window = VTR_SRC.slice(Math.max(0, at - 400), at)
    expect(
      window.includes('fillTranslateNdc('),
      'the packed pair no longer comes from the fillTranslateNdc producer (#2240)',
    ).toBe(true)
  })
})

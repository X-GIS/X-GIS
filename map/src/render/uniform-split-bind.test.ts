// ═══ #2042 INC-4b — UniformSplitBind: span-copy byte parity + stamp
//     discipline ═══
//
// The split write path COPIES show/frame lanes out of the live legacy
// polygonU bytes (uniform-split-bind.ts header). This suite is the CPU half
// of the rebind proof:
//   1. PARITY — with every polygonU field seeded a DISTINCT value, every
//      ShowBlock/FrameBlock lane the copy produces is byte-identical to the
//      same-named polygonU lane (a swapped span offset fails loud, which the
//      partition suite's same-value-per-kind packing could not catch), and
//      the two relocated flag lanes read the retiring vec4s' .w bytes.
//   2. STAMPS — frame/show copies run once per frameCount per identity
//      (the write path's whole point: N tiles, one copy).
//   3. WITNESS — the §5 skew hook actually flips the staged fill colour
//      (a dead witness would let the render gate's skew arm pass vacuously
//      — the assertion-that-failed-either-way class).

import { describe, it, expect } from 'vitest'
import type { RhiBuffer, RhiDevice } from '@xgis/rhi'
import { uniformBlock } from '@xgis/engine'
import { UniformSplitBind } from './uniform-split-bind'
import { TileUniformArena } from './tile-uniform-arena'
import { polygonU } from '../shaders/dsl/polygon'
import { showBlockU } from '../shaders/dsl/show-block'
import { frameBlockU } from '../shaders/dsl/frame-block'

interface FakeBuffer {
  label: string
  bytes: Uint8Array
  writes: number
}

function makeDevice() {
  const created: FakeBuffer[] = []
  const device = {
    createBuffer: (d: { size: number; label?: string }) => {
      const b: FakeBuffer = { label: d.label ?? '', bytes: new Uint8Array(d.size), writes: 0 }
      created.push(b)
      return b as unknown as RhiBuffer
    },
    writeBuffer: (buf: FakeBuffer, bufOffset: number, view: Uint8Array) => {
      buf.bytes.set(view, bufOffset)
      buf.writes++
    },
    destroyBuffer: () => {},
  } as unknown as RhiDevice
  const byLabel = (l: string) => created.find((b) => b.label === l)
  return { device, created, byLabel }
}

type FieldDecl = { name: string; type: { kind?: string; n?: number; elem?: string; name?: string } }
const declFields = (u: unknown): FieldDecl[] =>
  (u as { struct: { fields: FieldDecl[] } }).struct.fields

const isU32 = (t: FieldDecl['type']): boolean => t.elem === 'u32' || t.name === 'u32'
const sizeOf = (t: FieldDecl['type']): number =>
  t.kind === 'mat' ? 64 : t.kind === 'vec' ? (t.n === 2 ? 8 : 16) : 4

/** Seed EVERY non-pad polygonU lane with a field-unique value. */
function seedPolygon() {
  const polyB = uniformBlock(polygonU)
  let seed = 1
  for (const f of declFields(polygonU)) {
    if (f.name.startsWith('_pad')) continue
    const set = (polyB.set as unknown as Record<string, (...a: number[]) => void>)[f.name]!
    const t = f.type
    if (t.kind === 'mat') {
      ;(set as unknown as (m: Float32Array) => void)(
        Float32Array.from({ length: 16 }, (_, i) => seed + i * 0.5),
      )
    } else if (t.kind === 'vec') {
      if (t.n === 2) set(seed, seed + 0.25)
      else set(seed, seed + 0.25, seed + 0.5, seed + 0.75)
    } else if (isU32(t)) {
      set((0xa0000000 + seed * 7919) >>> 0)
    } else {
      set(seed + 0.125)
    }
    seed++
  }
  return polyB
}

function makeSplit(device: RhiDevice) {
  const tiles = new TileUniformArena(() => device)
  return new UniformSplitBind(
    () => device,
    tiles,
    null,
    () => {
      throw new Error('unwrap must not be reached without a native layout')
    },
    () => {},
  )
}

describe('UniformSplitBind — span-copy byte parity (the INC-4b rebind contract)', () => {
  it('every Show/Frame lane is byte-identical to its polygonU source, relocations included', () => {
    const { device, byLabel } = makeDevice()
    const split = makeSplit(device)
    const polyB = seedPolygon()
    const poly = new Uint8Array(polyB.buffer)

    const showOff = split.syncShow(polyB.buffer, 'countries', 3, 1)
    split.syncFrame(polyB.buffer, 1)
    split.flush()
    expect(showOff).toBe(0)

    const showBytes = byLabel('show-uniform-arena')!.bytes.subarray(showOff)
    const frameBytes = byLabel('frame-uniform-block')!.bytes
    const showB = uniformBlock(showBlockU)
    const frameB = uniformBlock(frameBlockU)

    const RELOCATED: Record<string, [src: string, byte: number]> = {
      fill_antialias: ['cam_ecef_off_h', 12],
      fill_vertical_gradient: ['cam_ecef_off_l', 12],
    }
    for (const [destName, destU, destB, dest] of [
      ['show', showBlockU, showB, showBytes],
      ['frame', frameBlockU, frameB, frameBytes],
    ] as const) {
      for (const f of declFields(destU)) {
        if (f.name.startsWith('_pad')) continue
        const rel = RELOCATED[f.name]
        const srcOff = rel
          ? polyB.fieldOffset(rel[0] as never) + rel[1]
          : polyB.fieldOffset(f.name as never)
        const size = rel ? 4 : sizeOf(f.type)
        const dOff = destB.fieldOffset(f.name as never)
        expect(
          [...dest.subarray(dOff, dOff + size)],
          `${destName}.${f.name}: copied bytes ≠ polygonU source — the split shader would read wrong data`,
        ).toEqual([...poly.subarray(srcOff, srcOff + size)])
      }
    }
    // Non-vacuity: the seeded source is nowhere all-zero.
    expect(frameBytes.some((b) => b !== 0)).toBe(true)
    expect(showBytes.subarray(0, 16).some((b) => b !== 0)).toBe(true)
  })

  it('copies once per frame per identity; re-stamps on the next frame', () => {
    const { device, byLabel } = makeDevice()
    const split = makeSplit(device)
    const polyB = seedPolygon()

    split.syncFrame(polyB.buffer, 7)
    split.syncFrame(polyB.buffer, 7)
    const frameBuf = byLabel('frame-uniform-block')!
    expect(frameBuf.writes, 'same frame → one frame upload').toBe(1)
    split.syncFrame(polyB.buffer, 8)
    expect(frameBuf.writes, 'next frame → refreshed').toBe(2)

    const o1 = split.syncShow(polyB.buffer, 'water', 0, 7)
    split.flush()
    const showBuf = byLabel('show-uniform-arena')!
    const w1 = showBuf.writes
    split.syncShow(polyB.buffer, 'water', 0, 7)
    split.flush()
    expect(showBuf.writes, 'same (slice, show, frame) → no re-stage, flush no-ops').toBe(w1)
    // Distinct shows get distinct 256-aligned slots; same show keeps its slot.
    const o2 = split.syncShow(polyB.buffer, 'water', 1, 7)
    expect(o2).not.toBe(o1)
    expect(o2 % 256).toBe(0)
    expect(split.syncShow(polyB.buffer, 'water', 0, 8)).toBe(o1)
  })

  it('lowered filter buckets sharing one pickId get DISTINCT slots (the demotiles aliasing)', () => {
    // The §5 gate caught this live: a data-driven paint lowered on the CPU
    // (countries-fill match()) fans one style layer into per-filter-bucket
    // sub-shows that SHARE the layer's pickId but carry different fill
    // colours. Keyed on pickId alone, the first bucket's copy stamped the
    // frame and every other bucket drew its colour. The slice key (which
    // carries the filter hash) must separate them.
    const { device, byLabel } = makeDevice()
    const split = makeSplit(device)
    const polyB = seedPolygon()
    const showB = uniformBlock(showBlockU)
    const colorOff = showB.fieldOffset('fill_color' as never)

    polyB.set.fill_color(0.9, 0.1, 0.1, 1) // bucket A's colour
    const oA = split.syncShow(polyB.buffer, 'countries:bucketA', 7, 1)
    polyB.set.fill_color(0.1, 0.9, 0.1, 1) // bucket B — same pickId, other slice
    const oB = split.syncShow(polyB.buffer, 'countries:bucketB', 7, 1)
    split.flush()
    expect(oB, 'same pickId + different slice must not alias one slot').not.toBe(oA)
    const staged = byLabel('show-uniform-arena')!.bytes
    const a = new Float32Array(staged.buffer, oA + colorOff, 4)
    const b = new Float32Array(staged.buffer, oB + colorOff, 4)
    expect([a[0], a[1]]).toEqual([Math.fround(0.9), Math.fround(0.1)])
    expect([b[0], b[1]]).toEqual([Math.fround(0.1), Math.fround(0.9)])
  })

  it('the §5 skew witness flips the staged fill colour (no dead witness)', () => {
    const { device, byLabel } = makeDevice()
    const polyB = seedPolygon()
    const g = globalThis as { __XGIS_SPLIT_BIND_SKEW?: unknown }
    try {
      const split = makeSplit(device)
      g.__XGIS_SPLIT_BIND_SKEW = true
      split.syncShow(polyB.buffer, 'water', 0, 1)
      split.flush()
      const showB = uniformBlock(showBlockU)
      const off = showB.fieldOffset('fill_color' as never)
      const staged = byLabel('show-uniform-arena')!.bytes
      const stagedRG = new Float32Array(staged.buffer, off, 2)
      const src = new Float32Array(polyB.buffer, polyB.fieldOffset('fill_color' as never), 2)
      expect(stagedRG[0]).toBeCloseTo(1 - src[0]!, 5)
      expect(stagedRG[1]).toBeCloseTo(1 - src[1]!, 5)
    } finally {
      delete g.__XGIS_SPLIT_BIND_SKEW
    }
  })
})

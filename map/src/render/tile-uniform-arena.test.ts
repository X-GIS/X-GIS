// ═══ TileUniformArena (#2042 INC-2) — lifecycle, leak, and the polygonU
//     byte-parity contract ═══
//
// Three things must hold before INC-4 may bind these slots:
//   1. LIFECYCLE — a slot per (slice, tile, worldCopy), packed once,
//      reused on every later call, freed by the store's release-hook key
//      (`${tileKey}:${sourceLayer}`), wholesale-dropped by resetAll.
//   2. LEAK — after every tile is released, live slots === 0 (the
//      UniformSlotArena's non-live-free throw makes a double-free loud;
//      this suite makes a MISSED free loud).
//   3. PARITY — the bytes staged into a TileBlock slot are byte-identical
//      to what VTR writes into the SAME-NAMED polygonU lanes for the same
//      tile today. That identity is what makes INC-4 a pure rebind: the
//      shader will read the same bytes from a different binding.

import { describe, it, expect } from 'vitest'
import type { RhiBuffer, RhiDevice } from '@xgis/rhi'
import { uniformBlock } from '@xgis/engine'
import { TileUniformArena } from './tile-uniform-arena'
import { tileBlockU } from '../shaders/dsl/tile-block'
import { polygonU } from '../shaders/dsl/polygon'
import { computeTileCameraAnchor } from './tile-camera-anchor'

interface FakeBuffer {
  id: string
  bytes: Uint8Array
}

function makeDevice() {
  const created: FakeBuffer[] = []
  let n = 0
  const device = {
    createBuffer: (d: { size: number }) => {
      const b: FakeBuffer = { id: `buf${n++}`, bytes: new Uint8Array(d.size) }
      created.push(b)
      return b as unknown as RhiBuffer
    },
    writeBuffer: (buf: FakeBuffer, bufOffset: number, view: Uint8Array) => {
      buf.bytes.set(view, bufOffset)
    },
    destroyBuffer: () => {},
  } as unknown as RhiDevice
  return { device, created }
}

const ANCHOR = computeTileCameraAnchor(139.74609375, 35.68359375, 0, 139.7671, 35.6812)
const EXTENT = 2445.98
const DQ_SCALE = 0.00012
const DQ_HALF = 8192

describe('TileUniformArena — lifecycle + leak', () => {
  it('allocates once per (slice, tile, copy); reuses the offset on every later frame', () => {
    const { device } = makeDevice()
    const a = new TileUniformArena(() => device)
    const o1 = a.ensureSlot('water', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    const o2 = a.ensureSlot('water', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    expect(o1).toBeGreaterThanOrEqual(0)
    expect(o2).toBe(o1)
    // distinct copies + distinct slices + distinct tiles are distinct slots
    const west = computeTileCameraAnchor(139.74609375, 35.68359375, -360, 139.7671, 35.6812)
    const oCopy = a.ensureSlot('water', 42, -360, west, EXTENT, DQ_SCALE, DQ_HALF)
    const oSlice = a.ensureSlot('roads', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    const oTile = a.ensureSlot('water', 43, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    expect(new Set([o1, oCopy, oSlice, oTile]).size).toBe(4)
    expect(a.liveSlots()).toBe(4)
    expect(a.liveTiles()).toBe(3) // (water,42) holds two copy lanes
  })

  it('a worldOff outside the ±2-copy lane range is refused (-1), not mis-slotted', () => {
    const { device } = makeDevice()
    const a = new TileUniformArena(() => device)
    expect(a.ensureSlot('water', 42, 3 * 360, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)).toBe(-1)
    expect(a.ensureSlot('water', 42, 90, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)).toBe(-1)
    expect(a.liveSlots()).toBe(0)
  })

  it('releaseTile frees EVERY copy lane via the store hook key; unknown keys are no-ops', () => {
    const { device } = makeDevice()
    const a = new TileUniformArena(() => device)
    a.ensureSlot('water', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.ensureSlot('water', 42, 360, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.ensureSlot('roads', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    expect(a.liveSlots()).toBe(3)
    a.releaseTile('42:water')
    expect(a.liveSlots()).toBe(1)
    expect(a.liveTiles()).toBe(1)
    a.releaseTile('42:water') // second fire (drop + supersede paths) — no-op
    a.releaseTile('999:water') // never uploaded — no-op
    a.releaseTile('42:roads')
    // LEAK GATE: every tile released ⇒ zero live slots.
    expect(a.liveSlots()).toBe(0)
    expect(a.liveTiles()).toBe(0)
  })

  it('hook keys keep the FIRST colon as the split (slice names may carry colons)', () => {
    const { device } = makeDevice()
    const a = new TileUniformArena(() => device)
    a.ensureSlot('landuse:f3a1', 7, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.releaseTile('7:landuse:f3a1')
    expect(a.liveSlots()).toBe(0)
  })

  it('resetAll drops every slot wholesale (the resetForReupload path)', () => {
    const { device } = makeDevice()
    const a = new TileUniformArena(() => device)
    a.ensureSlot('water', 1, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.ensureSlot('roads', 2, 360, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.resetAll()
    expect(a.liveSlots()).toBe(0)
    expect(a.liveTiles()).toBe(0)
    // arena stays usable after the wipe
    expect(a.ensureSlot('water', 1, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)).toBeGreaterThanOrEqual(0)
  })
})

describe('TileUniformArena — TileBlock ↔ polygonU byte parity (the INC-4 contract)', () => {
  it('every TileBlock lane is byte-identical to the same-named polygonU lane for the same tile', () => {
    // Left side: the bytes the arena stages (flush into the fake buffer).
    const { device, created } = makeDevice()
    const a = new TileUniformArena(() => device)
    const off = a.ensureSlot('water', 42, 0, ANCHOR, EXTENT, DQ_SCALE, DQ_HALF)
    a.flush()
    const staged = created[0]!.bytes.subarray(off)
    const tileB = uniformBlock(tileBlockU)

    // Right side: polygonU packed through the SAME setters VTR's per-tile
    // walk uses today (vector-tile-renderer renderTileKeys), same inputs.
    const polyB = uniformBlock(polygonU)
    polyB.set.tile_origin_merc_hl(
      ANCHOR.tileMercXH,
      ANCHOR.tileMercYH,
      ANCHOR.tileMercXL,
      ANCHOR.tileMercYL,
    )
    polyB.set.tile_extent_m(EXTENT)
    polyB.set.tile_dequant_scale(DQ_SCALE)
    polyB.set.tile_dequant_half(DQ_HALF)
    polyB.set.clip_bounds(-1e30, 0, 0, 0)
    polyB.set.tile_ecef_center_h(ANCHOR.tileEcefXH, ANCHOR.tileEcefYH, ANCHOR.tileEcefZH, 0)
    polyB.set.tile_ecef_center_l(ANCHOR.tileEcefXL, ANCHOR.tileEcefYL, ANCHOR.tileEcefZL, 0)
    const poly = new Uint8Array(polyB.buffer)

    const SPANS: ReadonlyArray<[field: string, bytes: number]> = [
      ['tile_origin_merc_hl', 16],
      ['tile_extent_m', 4],
      ['tile_dequant_scale', 4],
      ['tile_dequant_half', 4],
      ['clip_bounds', 16],
      ['tile_ecef_center_h', 16],
      ['tile_ecef_center_l', 16],
    ]
    for (const [field, bytes] of SPANS) {
      const to = tileB.fieldOffset(field as never)
      const po = polyB.fieldOffset(field as never)
      expect(
        [...staged.subarray(to, to + bytes)],
        `${field}: TileBlock bytes ≠ polygonU bytes — the INC-4 rebind would change pixels`,
      ).toEqual([...poly.subarray(po, po + bytes)])
    }
    // Non-vacuity: the load-bearing lanes actually carry data (a broken
    // pack that stages zeros must not pass by comparing zeros to zeros).
    expect(
      new Float32Array(
        created[0]!.bytes.buffer,
        off + tileB.fieldOffset('tile_ecef_center_h' as never),
        3,
      ).some((v) => v !== 0),
    ).toBe(true)
  })
})

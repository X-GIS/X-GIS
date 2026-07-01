// Uniform byte-layout consistency — sourced from reflect(), not a parallel hand table.
//
// The CPU packs a Float32Array (`uf[...]` in vector-tile-renderer) that must align
// BYTE-FOR-BYTE with the polygon DSL `struct Uniforms`. This file USED TO guard that by
// re-deriving the std140 offsets a THIRD time — a regex parser over the emitted WGSL +
// its own `WGSL_TYPES` alignment reimplementation + a 30-field `EXPECTED_F32_OFFSET`
// table — i.e. it was itself one of the duplicated copies that drift.
//
// Now the offsets come from reflect(buildPolygonModule()) via polygonUniformSlots() —
// the SAME IR the WGSL is emitted from. A few human-readable ANCHOR fields are spot-
// checked (a readable contract), plus the size/consumer invariants. No parallel std140
// reimplementation remains.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { polygonUniformSlots } from '@xgis/map'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('uniform byte-layout consistency (CPU pack ↔ DSL struct, via reflect())', () => {
  const { slot, slots } = polygonUniformSlots()

  it('anchor fields land at their contracted f32 slots (reflect-derived)', () => {
    // Human-readable spot-checks of the std140 layout reflect() computes from the IR.
    expect(slot.mvp).toBe(0)
    expect(slot.fill_color).toBe(16)
    expect(slot.stroke_color).toBe(20)
    expect(slot.proj_params).toBe(24)
    expect(slot.light_dir_ecef).toBe(60)
  })

  it('every slot is f32-aligned and within the uniform-ring slot stride', () => {
    for (const [name, s] of Object.entries(slot)) {
      expect(Number.isInteger(s), `${name} slot ${s} not integer`).toBe(true)
    }
    // #600 — the struct grew to 272 bytes (globe_eye @256), so the ring slot
    // stride stepped 256 → 512 (next 256-multiple ≥ 272). 512/4 = 128 f32 slots.
    // The struct itself is 272/4 = 68 f32 slots; assert it fits the 128 stride.
    expect(slots).toBe(68)
    expect(slots).toBeLessThanOrEqual(128)
  })

  it('the CPU packer (vector-tile-renderer) sources its slots from reflect(), not magic numbers', () => {
    // vector-tile-renderer.ts relocated to @xgis/map (P3 Batch B7); HERE is
    // runtime/src/engine/render → up 4 to repo root, then into map/src/render.
    const vtr = readFileSync(join(HERE, '..', '..', '..', '..', 'map', 'src', 'render', 'vector-tile-renderer.ts'), 'utf8')
    // The packer derives slots from polygonUniformSlots() (reflect) and writes at US.<field> —
    // no hand-coded magic indices to drift from the DSL struct.
    expect(vtr).toMatch(/polygonUniformSlots/)
    expect(vtr).toMatch(/uf\.set\(mvp,\s*US\.mvp\)/)
    expect(vtr).toMatch(/US\.fill_color/)
    expect(vtr).toMatch(/US\.stroke_color/)
    // proj_params + globe_eye are no longer packed inline here — they route through
    // the shared coupled writer (frame-projection-uniform.ts) so a missing globe_eye
    // (the #600 leak) is unrepresentable. The writer itself uses reflect slots.
    expect(vtr).toMatch(/writeFrameProjectionUniform/)
    // a bare numeric uniform-slot write (uf[16] / this.uniformF32[24] / this.uniformU32[36]
    // = …) must NOT survive — on ANY typed view over the uniform buffer.
    expect(vtr).not.toMatch(/\buf\[\d+\]/)
    expect(vtr).not.toMatch(/this\.uniformF32\[\d+\]/)
    expect(vtr).not.toMatch(/this\.uniformU32\[\d+\]/)
  })
})

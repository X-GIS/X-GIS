// ═══ View-driven arrow density, pinned at the layout and the emitted shader (#1450 B) ═══
//
// The arm-time stride reads the cell COUNT and nothing about the view (`coverage-arrow-show.ts`
// `arrowStride`), so zoomed out the arrows pile into a few pixels and zoomed in the field stays
// as sparse as the arm decided. The advected VS now thins per instance instead.
//
// WHAT IS PROVEN HERE and what is not. These are LAYOUT and EMIT facts — that the grid reaches
// the shader, that the shader reads it, and that the cull rides the existing zero-the-size
// mechanism rather than a second one. That the field ACTUALLY thins on zoom-out is a render
// claim and is gated where render claims belong: `playground/e2e/_s111-arrow-density-gate.spec.ts`
// measures it against the un-culled build.
//
// The numeric rule is deliberately NOT restated in TypeScript here. A CPU mirror of the shader's
// decimation would be a second authority for one rule, which is the drift §12 keeps paying for —
// the emitted text and the render gate are the two authorities that cannot silently disagree.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl, emitArrowRetainedAdvectedGlsl } from './arrow-retained'
import {
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_PARAM_GRID_NLON,
  S111_PARAM_GRID_NLAT,
  S111_PARAM_UV_ASPECT,
  S111_PARAM_STATE_BASE,
} from './s111-band-table-layout'
import { s111BandTableNormalized } from '../../render/s111-portrayal'

const paramsAt = (t: Float32Array, slot: number): number =>
  t[S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + slot]!

describe('the grid size reaches the shader (#1450 B)', () => {
  it('the params row carries nLon and nLat when a grid is declared', () => {
    const t = s111BandTableNormalized(2, 1.3, 's111-speed', [596, 433])
    expect(paramsAt(t, S111_PARAM_GRID_NLON)).toBe(596)
    expect(paramsAt(t, S111_PARAM_GRID_NLAT)).toBe(433)
  })

  it('the new slots do not disturb the two the row already carried', () => {
    // The params row is shared, and a slot collision would be invisible: the arrows would keep
    // drawing, pointed by a uvAspect that is really a cell count.
    const withGrid = s111BandTableNormalized(2, 1.3, 's111-speed', [596, 433])
    expect(paramsAt(withGrid, S111_PARAM_UV_ASPECT)).toBeCloseTo(1.3, 6) // f32 round-trip
    expect(paramsAt(withGrid, S111_PARAM_STATE_BASE)).toBe(0)
    expect(S111_PARAM_GRID_NLON).not.toBe(S111_PARAM_UV_ASPECT)
    expect(S111_PARAM_GRID_NLON).not.toBe(S111_PARAM_STATE_BASE)
    expect(S111_PARAM_GRID_NLAT).not.toBe(S111_PARAM_GRID_NLON)
  })

  it('an UNDECLARED grid leaves the slots zero — the shader reads that as "do not thin"', () => {
    // Zero must mean the whole field, not maximum decimation: a caller with no grid to declare
    // would otherwise silently lose its arrows.
    const t = s111BandTableNormalized(2, 1.3)
    expect(paramsAt(t, S111_PARAM_GRID_NLON)).toBe(0)
    expect(paramsAt(t, S111_PARAM_GRID_NLAT)).toBe(0)
  })

  it('the band rows are untouched by the params row gaining slots', () => {
    const a = s111BandTableNormalized(2, 1.3, 's111-speed')
    const b = s111BandTableNormalized(2, 1.3, 's111-speed', [596, 433])
    const bandFloats = S111_BAND_PARAMS_ROW * S111_BAND_STRIDE
    expect([...b.subarray(0, bandFloats)]).toEqual([...a.subarray(0, bandFloats)])
  })
})

describe('the advected VS thins by SCREEN cell spacing (#1450 B)', () => {
  const w = emitArrowRetainedAdvectedWgsl()

  it('reads BOTH grid slots out of the params row, at the indices the layout declares', () => {
    // The index is COMPUTED from the layout constants rather than spelled out, so moving a slot
    // moves this assertion with it instead of leaving a stale magic number that still passes.
    for (const slot of [S111_PARAM_GRID_NLON, S111_PARAM_GRID_NLAT]) {
      const at = S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + slot
      expect(w, `band_data[${at}u] (params row slot ${slot})`).toContain(`band_data[${at}u]`)
    }
  })

  it('derives the level from the projected BASES, not from a camera scalar', () => {
    // The whole point of measuring at the arrow's own position is that a pitched frame decimates
    // its horizon harder than its foreground. A camera-wide stride cannot express that, so a
    // rewrite that reached for one would be a regression this pins.
    expect(w).toMatch(/log2/)
    expect(w).toMatch(/exp2/)
    expect(w).toMatch(/ceil/)
  })

  it('the cull rides the size product — one way for an arrow not to be drawn, not two', () => {
    // `size` is already zeroed for a speed-0 cell and for a failed perspective guard, and a zero
    // length collapses the quad. The density factor multiplies into the SAME product. A separate
    // early-out would be a second mechanism to keep in step with the quad emit below it — so the
    // VS must still have exactly ONE return, and no branch that skips the emit.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    expect(body.match(/\breturn\b/g) ?? []).toHaveLength(1)
    // …and the factor itself is present: the exact-integer test the nesting argument rests on.
    expect(body).toMatch(/fract\(/)
  })

  it('the GLSL twin carries the same thinning — one backend must not draw a denser field', () => {
    const g = emitArrowRetainedAdvectedGlsl('vertex')
    expect(g).toMatch(/log2/)
    expect(g).toMatch(/exp2/)
    expect(g).toMatch(/fract/)
  })

  it('the STATIC arrow VS is untouched — it declares no grid and thins nothing', () => {
    // #1450's endpoint is one portrayal; until then the static path keeps its arm-time stride
    // and its byte-identical shader. A change here would be scope this increment did not take.
    const vs = w.slice(0, w.indexOf('fn vs_arrow_retained_advected'))
    expect(vs).not.toMatch(/exp2/)
  })
})

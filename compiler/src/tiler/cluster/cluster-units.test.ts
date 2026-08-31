// The cluster boundary's numeric conventions, pinned one mechanism at a time (#2050,
// design §2 / §4.4). Every `it` below dies to a DIFFERENT cut: the ×16 radius scale, the
// minPoints lift, the Int32 quantization, the cluster_id packing, and the
// point_count_abbreviated type asymmetry are separate claims and a single "the numbers
// look right" assertion would survive most of them.

import { describe, expect, it } from 'vitest'
import { abbreviatePointCount } from './cluster-props'
import {
  MAX_CLUSTERABLE_POINTS,
  MAX_CLUSTER_ZOOM,
  QUANT_SCALE,
  RADIUS_TILE_SIZE,
  assertClusterIdCapacity,
  clusterIdFor,
  dequantizeUnit,
  quantizeUnit,
  resolveClusterOptions,
  unitToQuant,
} from './units'

describe('cluster units: clusterRadius is 512-px tile pixels, scaled here (#2050 §2)', () => {
  it('the default 50 px becomes 800 extent units at extent 8192 — the ×16 this boundary owns', () => {
    // `SourceDef.clusterRadius` carries the raw style value (ir/source-cluster.ts UNITS,
    // and #2050's P1 decision comment). Passing that 50 straight into the neighbourhood
    // test would cluster at 1/16 the intended radius.
    expect(resolveClusterOptions().radiusExtent).toBe(800)
    expect(RADIUS_TILE_SIZE).toBe(512)
  })

  it('scales with the extent, not by a baked constant', () => {
    expect(resolveClusterOptions({ radius: 50, extent: 4096 }).radiusExtent).toBe(400)
    expect(resolveClusterOptions({ radius: 40, extent: 512 }).radiusExtent).toBe(40)
  })
})

describe('cluster units: minPoints is lifted to 2, never rounded (#2050 §2)', () => {
  it.each([
    [undefined, 2],
    [0, 2],
    [1, 2],
    [2, 2],
    [5, 5],
  ])('minPoints %s resolves to %s', (given, expected) => {
    expect(resolveClusterOptions(given === undefined ? {} : { minPoints: given }).minPoints).toBe(
      expected,
    )
  })

  it('keeps a FRACTIONAL minPoints fractional — 2.4 means "3 or more"', () => {
    // `convert/sources-cluster.ts` deliberately does not round this one (it rounds only
    // clusterMaxZoom, which is what MapLibre rounds). Rounding it here would quietly
    // change 2.4 from "3 or more" to "2 or more".
    expect(resolveClusterOptions({ minPoints: 2.4 }).minPoints).toBe(2.4)
  })
})

describe('cluster units: the Int32 quantization of the unit square (#2050 §2)', () => {
  it('maps [0,1] into the Int32 band and back', () => {
    expect(quantizeUnit(0)).toBe(-QUANT_SCALE / 2)
    expect(quantizeUnit(0.5)).toBe(0)
    expect(quantizeUnit(1)).toBe(QUANT_SCALE / 2)
    expect(dequantizeUnit(quantizeUnit(0.5))).toBe(0.5)
  })

  it('CLAMPS out-of-range input rather than overflowing the Int32Array silently', () => {
    // A longitude past ±180 projects outside the unit square; without the clamp the
    // rounded value wraps and the point lands somewhere else entirely.
    expect(quantizeUnit(2)).toBe(QUANT_SCALE / 2)
    expect(quantizeUnit(-1)).toBe(-QUANT_SCALE / 2)
  })

  it('is LOSSY — which is exactly why single points are not emitted through it', () => {
    // The premise of the drift-free-unclustered rule (design §2): the round trip moves a
    // coordinate by up to half a quantum, ~1.9 cm at the equator. If this ever became
    // lossless the rule would be vacuous, so the premise is asserted, not assumed.
    const c = 100 / 3 / 360 + 0.5
    expect(dequantizeUnit(quantizeUnit(c))).not.toBe(c)
    expect(Math.abs(dequantizeUnit(quantizeUnit(c)) - c)).toBeLessThanOrEqual(0.5 / QUANT_SCALE)
  })

  it('unitToQuant does NOT round or clamp — tile-buffer query bounds leave the unit square', () => {
    expect(unitToQuant(-0.05)).toBeCloseTo(-0.55 * QUANT_SCALE, 0)
    expect(unitToQuant(0.5 + 0.25 / QUANT_SCALE)).not.toBe(0)
  })
})

describe('cluster units: cluster_id keeps supercluster’s decodable packing (#2050 §4.4)', () => {
  it('packs (origin index, zoom) above the point-count offset', () => {
    expect(clusterIdFor(0, 0, 100)).toBe(101)
    expect(clusterIdFor(1, 0, 100)).toBe(32 + 1 + 100)
    expect(clusterIdFor(0, 5, 100)).toBe(6 + 100)
  })

  it('DECODES back to (origin index, origin zoom) — the only reason this scheme was kept', () => {
    // Design §4.4 rejected a dense sequential id precisely because it makes
    // getClusterExpansionZoom / getChildren unimplementable without a side table. That
    // claim is only true while this decode works.
    const pointCount = 4096
    for (const originIndex of [0, 1, 37, 4095]) {
      for (const zoom of [0, 7, 14, MAX_CLUSTER_ZOOM]) {
        const id = clusterIdFor(originIndex, zoom, pointCount)
        expect((id - pointCount) >> 5).toBe(originIndex)
        expect(((id - pointCount) % 32) - 1).toBe(zoom)
      }
    }
  })

  it('never collides across zooms or origins', () => {
    const pointCount = 64
    const seen = new Set<number>()
    for (let originIndex = 0; originIndex < 64; originIndex++) {
      for (let zoom = 0; zoom <= MAX_CLUSTER_ZOOM; zoom++) {
        const id = clusterIdFor(originIndex, zoom, pointCount)
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
  })

  it('asserts its own arithmetic bounds, and the assert is REACHABLE', () => {
    // Design §4.4: "the bound goes in the code as an assert, not a comment". It takes its
    // inputs as arguments so a gate can drive it to the cliff without 67 M points — an
    // assert nothing can execute is not an assert.
    expect(() =>
      assertClusterIdCapacity(MAX_CLUSTERABLE_POINTS - 1, MAX_CLUSTER_ZOOM),
    ).not.toThrow()
    expect(() => assertClusterIdCapacity(MAX_CLUSTERABLE_POINTS, 14)).toThrow(/cluster_id capacity/)
    expect(() => assertClusterIdCapacity(10, MAX_CLUSTER_ZOOM + 1)).toThrow(/5-bit zoom field/)
  })

  it('the bound is REAL — one point past it the shift wraps negative', () => {
    // Proves the assert guards something rather than being decorative.
    expect(MAX_CLUSTERABLE_POINTS << 5).toBeLessThan(0)
    expect((MAX_CLUSTERABLE_POINTS - 1) << 5).toBeGreaterThan(0)
  })
})

describe('cluster props: point_count_abbreviated’s number/string asymmetry (#2050 §2)', () => {
  it.each([
    [1, 1],
    [999, 999],
    [1000, '1k'],
    [1049, '1k'],
    [1050, '1.1k'],
    [9999, '10k'],
    [10000, '10k'],
    [23456, '23k'],
  ])('%s abbreviates to %o', (count, expected) => {
    expect(abbreviatePointCount(count)).toBe(expected)
  })

  it('is a NUMBER below 1000 and a STRING at or above it', () => {
    // The asymmetry a naive String(n) gets wrong. MVT property encoding preserves the
    // distinction faithfully, so `["==", ["get","point_count_abbreviated"], 999]` in a
    // style depends on it.
    expect(typeof abbreviatePointCount(999)).toBe('number')
    expect(typeof abbreviatePointCount(1000)).toBe('string')
  })
})

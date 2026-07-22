import { describe, it, expect } from 'vitest'
import type { GeoJSONFeature } from '@xgis/data'
import type { LabelDef } from '@xgis/compiler'
import {
  placeLabelsAlongLine,
  placeInlineLineLabels,
  withinViewportInset,
} from './place-labels-along-line'

// #1314 — line labels placed along a viewport-clipped run otherwise drop a stop
// every `symbol-spacing` from wherever the road ENTERS the viewport, so the
// first/last stops sit right at the two screen edges and render half-clipped
// ("화면 기준 양 끝으로 라벨이 붙어서 가시성 및 가독성이 나빠지는"). The along-line
// walk now takes an optional edge-inset `cull` predicate; near-edge stops are
// dropped and the walk continues to the next stop. This pins the placement math
// directly (exact screen positions), the authority for a positioning change.

describe('#1314 withinViewportInset — line-label edge-inset predicate', () => {
  const W = 800
  const H = 600
  const INSET = 48

  it('keeps an anchor comfortably inside the viewport', () => {
    expect(withinViewportInset(400, 300, W, H, INSET)).toBe(true)
  })

  it('culls an anchor within the inset of each edge', () => {
    expect(withinViewportInset(10, 300, W, H, INSET), 'left').toBe(false)
    expect(withinViewportInset(795, 300, W, H, INSET), 'right').toBe(false)
    expect(withinViewportInset(400, 10, W, H, INSET), 'top').toBe(false)
    expect(withinViewportInset(400, 595, W, H, INSET), 'bottom').toBe(false)
  })

  it('treats the inset boundary as inclusive (an anchor exactly `inset` in is kept)', () => {
    expect(withinViewportInset(INSET, INSET, W, H, INSET)).toBe(true)
    expect(withinViewportInset(W - INSET, H - INSET, W, H, INSET)).toBe(true)
    // A hair OUTSIDE the boundary is culled — proves the comparison is `>=`, not `>`.
    expect(withinViewportInset(INSET - 0.001, 300, W, H, INSET)).toBe(false)
  })
})

describe('#1314 placeLabelsAlongLine — cull drops near-edge stops, keeps interior', () => {
  // A horizontal line spanning an 800×600 viewport at mid-height. 3 vertices ⇒ a
  // straight run of total length 800; spacing 100 ⇒ stops at 50,150,…,750.
  const px = Float32Array.from([0, 400, 800])
  const py = Float32Array.from([300, 300, 300])
  const walk = (cull?: (x: number, y: number) => boolean): number[] => {
    const xs: number[] = []
    placeLabelsAlongLine(
      px,
      py,
      3,
      100,
      (pax, _pay, pbx, _pby, t) => xs.push(pax + (pbx - pax) * t),
      cull,
    )
    return xs.sort((a, b) => a - b)
  }

  it('emits every stop when no cull is supplied (historical behaviour unchanged)', () => {
    expect(walk()).toEqual([50, 150, 250, 350, 450, 550, 650, 750])
  })

  it('drops the two near-edge stops (x=50, x=750) at inset 60, keeps the interior six', () => {
    const kept = walk((x, y) => withinViewportInset(x, y, 800, 600, 60))
    expect(kept).toEqual([150, 250, 350, 450, 550, 650])
  })

  it('culling is per-stop: the walk continues past a culled stop (not a stop-the-walk)', () => {
    // Cull ONLY the first stop; every later stop must still emit — a culled stop
    // must not short-circuit the remaining spacing walk.
    const kept = walk((x) => x > 60)
    expect(kept).toEqual([150, 250, 350, 450, 550, 650, 750])
  })

  it('a line whose visible run hugs one edge yields no labels (all stops culled)', () => {
    // The whole run sits in the left inset band [0,40]; every stop is unreadable
    // and correctly dropped rather than glued to the border.
    const hx = Float32Array.from([0, 20, 40])
    const hy = Float32Array.from([300, 300, 300])
    const xs: number[] = []
    placeLabelsAlongLine(
      hx,
      hy,
      3,
      10,
      (pax, _pay, pbx, _pby, t) => xs.push(pax + (pbx - pax) * t),
      (x, y) => withinViewportInset(x, y, 800, 600, 60),
    )
    expect(xs).toEqual([])
  })
})

describe('#1314 placeInlineLineLabels — the inline (raw-GeoJSON) path also culls near-edge stops', () => {
  // The inline path (a geojson source, not vector tiles) delegates to the same
  // along-line walk; the cull now reaches it too, so an inline LineString gets the
  // identical edge-readability treatment as OFM road labels.
  const LINE_DEF = {
    text: { kind: 'lit', value: 'X' } as unknown,
    placement: 'line',
    spacing: 100,
  } as unknown as LabelDef
  const lineFeature = (lons: number[]): GeoJSONFeature =>
    ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: lons.map((x) => [x, 0]) },
    }) as unknown as GeoJSONFeature
  // Identity projector, but pins screen-y to a viewport-interior row (300) so the
  // cull decision is driven purely by the x walk, not the fixed y.
  const inlinePlacedXs = (lons: number[], cull?: (px: number, py: number) => boolean): number[] => {
    const xs: number[] = []
    placeInlineLineLabels(
      lineFeature(lons),
      LINE_DEF,
      () => LINE_DEF,
      (lon) => [lon, 300],
      1,
      (_v, _p, x) => {
        xs.push(x)
      },
      () => {},
      undefined,
      cull,
    )
    return xs.sort((a, b) => a - b)
  }

  it('places every stop when no cull is supplied (inline behaviour unchanged)', () => {
    expect(inlinePlacedXs([0, 400, 800])).toEqual([50, 150, 250, 350, 450, 550, 650, 750])
  })

  it('drops the two near-edge stops at inset 60 (x=50 left band, x=750 right band)', () => {
    const kept = inlinePlacedXs([0, 400, 800], (x, y) => withinViewportInset(x, y, 800, 600, 60))
    expect(kept).toEqual([150, 250, 350, 450, 550, 650])
  })
})

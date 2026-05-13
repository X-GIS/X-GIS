// Unit tests for buildLabelShapes. Pins the precedence rule
// (data-driven > zoom-stops > constant) on each of the four
// shape-able label paint properties.

import { describe, it, expect } from 'vitest'
import { buildLabelShapes } from '../ir/render-node'
import type { ZoomStop, DataExpr } from '../ir/render-node'

const FAKE_EXPR: DataExpr = { ast: { kind: 'NumberLiteral', value: 0, unit: null } as never }
const SIZE_STOPS: ZoomStop<number>[] = [{ zoom: 4, value: 10 }, { zoom: 16, value: 22 }]
const COLOR_STOPS: ZoomStop<[number, number, number, number]>[] = [
  { zoom: 4, value: [1, 0, 0, 1] },
  { zoom: 16, value: [0, 0, 1, 1] },
]
const RED: [number, number, number, number] = [1, 0, 0, 1]
const BLACK: [number, number, number, number] = [0, 0, 0, 1]

describe('buildLabelShapes — size precedence', () => {
  it('uses constant when no stops and no expr', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.size).toEqual({ kind: 'constant', value: 14 })
  })

  it('uses zoom-interpolated when sizeZoomStops set', () => {
    const shapes = buildLabelShapes({ size: 14, sizeZoomStops: SIZE_STOPS })
    expect(shapes.size.kind).toBe('zoom-interpolated')
    if (shapes.size.kind === 'zoom-interpolated') {
      expect(shapes.size.stops).toBe(SIZE_STOPS)
    }
  })

  it('carries sizeZoomStopsBase through', () => {
    const shapes = buildLabelShapes({
      size: 14, sizeZoomStops: SIZE_STOPS, sizeZoomStopsBase: 1.5,
    })
    if (shapes.size.kind === 'zoom-interpolated') {
      expect(shapes.size.base).toBe(1.5)
    }
  })

  it('data-driven wins over both zoom-stops and constant', () => {
    const shapes = buildLabelShapes({
      size: 14, sizeZoomStops: SIZE_STOPS, sizeExpr: FAKE_EXPR,
    })
    expect(shapes.size.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — color precedence', () => {
  it('null when no color authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.color).toBeNull()
  })

  it('constant when only `color` set', () => {
    const shapes = buildLabelShapes({ size: 14, color: RED })
    expect(shapes.color).toEqual({ kind: 'constant', value: RED })
  })

  it('zoom-interpolated when colorZoomStops set', () => {
    const shapes = buildLabelShapes({ size: 14, color: RED, colorZoomStops: COLOR_STOPS })
    expect(shapes.color?.kind).toBe('zoom-interpolated')
  })

  it('data-driven wins', () => {
    const shapes = buildLabelShapes({
      size: 14, color: RED, colorZoomStops: COLOR_STOPS, colorExpr: FAKE_EXPR,
    })
    expect(shapes.color?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — halo width', () => {
  it('null when no halo authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.haloWidth).toBeNull()
  })

  it('constant from halo.width', () => {
    const shapes = buildLabelShapes({ size: 14, halo: { color: BLACK, width: 2 } })
    expect(shapes.haloWidth).toEqual({ kind: 'constant', value: 2 })
  })

  it('zoom-interpolated wins over constant', () => {
    const stops: ZoomStop<number>[] = [{ zoom: 4, value: 1 }, { zoom: 12, value: 3 }]
    const shapes = buildLabelShapes({
      size: 14,
      halo: { color: BLACK, width: 2 },
      haloWidthZoomStops: stops,
      haloWidthZoomStopsBase: 2,
    })
    expect(shapes.haloWidth?.kind).toBe('zoom-interpolated')
    if (shapes.haloWidth?.kind === 'zoom-interpolated') {
      expect(shapes.haloWidth.base).toBe(2)
    }
  })
})

describe('buildLabelShapes — halo color', () => {
  it('null when no halo authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.haloColor).toBeNull()
  })

  it('constant from halo.color', () => {
    const shapes = buildLabelShapes({ size: 14, halo: { color: BLACK, width: 1 } })
    expect(shapes.haloColor).toEqual({ kind: 'constant', value: BLACK })
  })

  it('zoom-interpolated wins over constant', () => {
    const shapes = buildLabelShapes({
      size: 14,
      halo: { color: BLACK, width: 1 },
      haloColorZoomStops: COLOR_STOPS,
    })
    expect(shapes.haloColor?.kind).toBe('zoom-interpolated')
  })
})
